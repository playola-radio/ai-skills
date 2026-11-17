const VALID_CASE_ID = /^[a-z0-9-]+$/;

export function assertValidCaseId(id: string): void {
  if (!VALID_CASE_ID.test(id)) throw new Error("case id must be lowercase letters, digits and hyphens");
}
