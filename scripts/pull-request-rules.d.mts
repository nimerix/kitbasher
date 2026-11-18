export type VersionBump = 'major' | 'minor' | 'patch';
export const pullRequestTypes: Record<string, { label: string; bump: VersionBump }>;
export const requiredSections: string[];
export function parseTitle(
  title: string,
): { type: string; breaking: boolean; subject: string } | undefined;
export function checkTitle(title: string): string[];
export function checkBody(body: string | null | undefined): string[];
export function bumpVersion(version: string, level: VersionBump): string;
export function isNewer(a: string, b: string): boolean;
export function expectedBump(title: string): VersionBump | undefined;
