// lib/extraction.js
// Claude API call: meeting transcript + attendee names -> structured project JSON.
//
// Output contract (per CLAUDE.md §5, consumed by api/meetings/ingest.js,
// which resolves attendees via lib/roster.js and calls the confirm flow):
//   { project_name: string|null, deliverables: [{team, task, owner_name, due_date}], due_dates: string|null }
// due_dates is the free-text, human-readable summary of every date mentioned
// (shown as-is on the dashboard); each deliverable's own due_date is a
// separate, individually-parseable date string (or null to inherit the
// project's overall due date) — see lib/clickup.js for how the two combine.

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
            team: { type: "string", enum: ["content", "design", "dev", "video_design"] },
            task: { type: "string" },
            owner_name: {
              type: ["string", "null"],
              description:
                "The person named as responsible for this task, exactly as spoken/referred to in the " +
                "transcript — this can be someone NOT in the attendee list (e.g. delegated to someone " +
                "who wasn't on the call). Use null only if the transcript never names an owner for this " +
                "task at all.",
            },
            due_date: {
              type: ["string", "null"],
              description:
                "THIS deliverable's own due date, ONLY if the transcript states one specifically for it " +
                "(e.g. 'design by August 5th' -> 'August 5th' for the design deliverable). Write it as a " +
                "clean, individually parseable date phrase (e.g. 'August 5th', 'August 5, 2026') — not a " +
                "sentence. Use null if this deliverable has no date of its own and only the overall " +
                "project due date applies to it.",
            },
          },
          required: ["team", "task", "owner_name", "due_date"],
        },
      },
      due_dates: {
        type: ["string", "null"],
        description:
          "Human-readable summary of every due date mentioned for the project, in the words used " +
          "(can be a full sentence covering multiple dates) — shown as-is on the dashboard. Null if none mentioned.",
      },
      project_due_date: {
        type: ["string", "null"],
        description:
          "The single overall/final due date for the whole project (e.g. the event date, or the last " +
          "milestone everything must be ready by) as a clean, individually parseable date phrase (e.g. " +
          "'August 15th') — not a sentence. Null if no overall project date was mentioned.",
      },
      summary: {
        type: "string",
        description: "2-3 sentence plain-language summary of what was discussed and decided in the meeting",
      },
    },
    required: ["project_name", "deliverables", "due_dates", "project_due_date", "summary"],
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
        "You extract project plans from meeting transcripts. The attendee list is who was captured " +
        "as present on the call — useful context for spelling names correctly, but NOT a whitelist: " +
        "a task can be delegated to someone not on the call (e.g. 'let Shweta take the video'), and " +
        "that deliverable must still be captured with owner_name set to that person's name. Never omit " +
        "a discussed task just because its owner isn't in the attendee list — only use owner_name: null " +
        "when the transcript truly never names anyone for that task. If the transcript does not discuss " +
        "a concrete project with deliverables at all, return project_name: null and an empty " +
        "deliverables array rather than guessing. For dates: a deliverable's due_date field is ONLY for a " +
        "date stated specifically for THAT deliverable (e.g. 'design by August 5th') — leave it null " +
        "when a task has no date of its own. project_due_date is the one overall/final date for the " +
        "whole project. Both must be clean individually-parseable phrases like 'August 5th', never a " +
        "sentence — due_dates is the only field allowed to be a full free-text sentence.",
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
  return normalizeExtracted(toolUse.input);
}

const VALID_TEAMS = new Set(["content", "design", "dev", "video_design"]);

/**
 * Coerce deliverables into a clean array of {team, task, owner_name}.
 * Exists because tool_choice-forced output is not guaranteed to match the
 * schema: seen live (2026-07-09, meeting sdb-wvks-ygy), the model returned
 * deliverables as a JSON-STRING ('{"deliverables":[...]}') — downstream
 * code then iterated it character by character and created hundreds of
 * "[undefined] undefined" ClickUp subtasks before crashing. Never trust
 * model output shape; normalize at the boundary. Exported so the
 * assignment step can also sanitize payloads confirmed BEFORE this fix
 * landed (they're stored verbatim in pending_confirmations).
 */
export function normalizeDeliverables(raw) {
  let value = raw;

  // String-encoded JSON → parse; unwrap a nested {deliverables: [...]}.
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      console.error("[extraction] deliverables was an unparseable string — dropping:", value.slice(0, 120));
      return [];
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.deliverables)) {
    value = value.deliverables;
  }
  if (!Array.isArray(value)) {
    if (value != null) console.error("[extraction] deliverables had unexpected shape — dropping:", typeof value);
    return [];
  }

  const clean = [];
  for (const d of value) {
    if (!d || typeof d !== "object" || Array.isArray(d)) continue;
    const team = typeof d.team === "string" ? d.team.trim().toLowerCase() : "";
    const task = typeof d.task === "string" ? d.task.trim() : "";
    if (!VALID_TEAMS.has(team) || !task) {
      console.error("[extraction] dropping malformed deliverable:", JSON.stringify(d).slice(0, 120));
      continue;
    }
    clean.push({
      team,
      task,
      owner_name: typeof d.owner_name === "string" && d.owner_name.trim() ? d.owner_name.trim() : null,
      due_date: typeof d.due_date === "string" && d.due_date.trim() ? d.due_date.trim() : null,
    });
  }
  return clean;
}

function normalizeExtracted(input) {
  const out = input && typeof input === "object" ? input : {};
  return {
    project_name: typeof out.project_name === "string" && out.project_name.trim() ? out.project_name.trim() : null,
    deliverables: normalizeDeliverables(out.deliverables),
    due_dates: typeof out.due_dates === "string" && out.due_dates.trim() ? out.due_dates.trim() : null,
    project_due_date:
      typeof out.project_due_date === "string" && out.project_due_date.trim() ? out.project_due_date.trim() : null,
    summary: typeof out.summary === "string" ? out.summary : "",
  };
}
