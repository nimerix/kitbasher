export const pullRequestTypes: Record<string, { label: string }>;
export const requiredSections: string[];
export function parseTitle(
  title: string,
): { type: string; breaking: boolean; subject: string } | undefined;
export function checkTitle(title: string): string[];
export function checkBody(body: string | null | undefined): string[];
