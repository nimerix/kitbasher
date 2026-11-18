import { readFileSync } from 'node:fs';
import { checkBody, checkTitle, pullRequestTypes } from './pull-request-rules.mjs';

const event = process.env.GITHUB_EVENT_PATH
  ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).pull_request
  : undefined;
const title = process.env.PR_TITLE ?? event?.title ?? '';
const body = process.env.PR_BODY_FILE
  ? readFileSync(process.env.PR_BODY_FILE, 'utf8')
  : (process.env.PR_BODY ?? event?.body ?? '');

const failures = [...checkTitle(title), ...checkBody(body)];
if (failures.length) {
  console.error(`Pull request format check failed:\n- ${failures.join('\n- ')}`);
  console.error(
    `\nTitle types:\n${Object.entries(pullRequestTypes)
      .map(([type, { label }]) => `  ${type}: ${label}`)
      .join('\n')}\nSee CONTRIBUTING.md and .github/pull_request_template.md.`,
  );
  process.exit(1);
}
console.log(`Pull request format is valid: ${title}`);
