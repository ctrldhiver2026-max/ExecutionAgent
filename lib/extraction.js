// lib/extraction.js
// Claude API call: meeting transcript + attendee names -> structured project JSON.
//
// Output contract (per CLAUDE.md §5, consumed by api/meetings/ingest.js,
// which resolves attendees via lib/roster.js and calls the confirm flow):
//   { project_name: string|null, deliverables: [{team, task, owner_name}], due_dates: string|null }

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-5";

const EXTRACT_TOOL = {
  name: "extract_project",
  description:
    "Extract the project discussed in a meeting transcript, split into deliverables per team.",
  input_schema: {
    type: "object",
    properties: {
      project_name: {
        type: ["string", "null"],
        description: "Short name for the project discussed, or null if no concrete project was discussed.",
      },
      deliverables: {
        type: "array",
        items: {
          type: "object",
          properties: {
            team: { type: "string", enum: ["content", "design", "dev"] },
            task: { type: "string" },
            owner_name: {
              type: ["string", "null"],
              description:
                "Must match a name from the attendee list verbatim, or null if unassigned/unclear.",
            },
          },
          required: ["team", "task", "owner_name"],
        },
      },
      due_dates: {
        type: ["string", "null"],
        description: "Any due date(s) mentioned for the project, in the words used, or null if none mentioned.",
      },
      summary: {
        type: "string",
        description: "2-3 sentence plain-language summary of what was discussed and decided in the meeting",
      },
    },
    required: ["project_name", "deliverables", "due_dates", "summary"],
  },
};

/**
 * @param {{ transcript: {speaker: string, text: string}[], attendees: string[] }} input
 * @returns {Promise<{project_name: string|null, deliverables: object[], due_dates: string|null}>}
 */
export async function extractProject({ transcript = [], attendees = [] }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  const transcriptText = transcript.map((line) => `${line.speaker}: ${line.text}`).join("\n");

  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system:
        "You extract project plans from meeting transcripts. Attendee names are the only valid " +
        "owner_name values — never invent a name that is not in the attendee list. If the transcript " +
        "does not discuss a concrete project with deliverables, return project_name: null and an " +
        "empty deliverables array rather than guessing.",
      messages: [
        {
          role: "user",
          content: `Attendees: ${attendees.join(", ") || "(none captured)"}\n\nTranscript:\n${transcriptText || "(empty)"}`,
        },
      ],
      tools: [EXTRACT_TOOL],
      tool_choice: { type: "tool", name: "extract_project" },
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const toolUse = data.content?.find((block) => block.type === "tool_use");
  if (!toolUse) throw new Error("No tool_use block in Claude response");
  return toolUse.input;
}
