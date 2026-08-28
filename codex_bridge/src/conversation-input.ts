import type { MaterializedTextArtifact, WorkPackage } from "./types.js";

export interface CodexUserInput {
  message: string;
  context?: string;
  acceptanceCriteria?: string[];
  constraints?: string[];
  artifacts?: MaterializedTextArtifact[];
}

export function buildCodexUserInput(input: CodexUserInput): string {
  const sections = [input.message];
  if (input.context) {
    sections.push(taggedText("USER_CONTEXT", input.context));
  }
  if (input.acceptanceCriteria?.length) {
    sections.push(taggedList("USER_ACCEPTANCE_CRITERIA", input.acceptanceCriteria));
  }
  if (input.constraints?.length) {
    sections.push(taggedList("USER_CONSTRAINTS", input.constraints));
  }
  for (const artifact of input.artifacts ?? []) {
    sections.push(renderTextArtifact(artifact));
  }
  return sections.join("\n\n");
}

export function buildInitialTurnUserInput(
  workPackage: WorkPackage,
  artifacts: MaterializedTextArtifact[],
): string {
  return buildCodexUserInput({
    message: workPackage.objective,
    context: workPackage.context || undefined,
    acceptanceCriteria: workPackage.acceptanceCriteria,
    constraints: workPackage.constraints,
    artifacts,
  });
}

function taggedText(tag: string, content: string): string {
  return `[${tag}]\n${content}\n[/${tag}]`;
}

function taggedList(tag: string, items: string[]): string {
  return `[${tag}]\n${items.map((item, index) => `${index + 1}. ${item}`).join("\n")}\n[/${tag}]`;
}

function renderTextArtifact(artifact: MaterializedTextArtifact): string {
  return [
    "[ATTACHED_TEXT_ARTIFACT]",
    "---METADATA---",
    `id: ${artifact.id}`,
    `fileName: ${JSON.stringify(artifact.fileName)}`,
    `mimeType: ${artifact.mimeType}`,
    `chars: ${artifact.chars}`,
    `bytes: ${artifact.bytes}`,
    `sha256: ${artifact.sha256}`,
    `localPath: ${JSON.stringify(artifact.localPath)}`,
    "---CONTENT---",
    artifact.content,
    "---END CONTENT---",
    "[/ATTACHED_TEXT_ARTIFACT]",
  ].join("\n");
}
