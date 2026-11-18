/** The short hash of the commit this build was made from, as GitHub shows it. */
export const buildCommit: string = import.meta.env.VITE_BUILD_COMMIT || 'dev';
