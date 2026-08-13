const rules: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /\b(?:sk|sess|pat|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/g,
  /\bAuthorization\s*:\s*[^\r\n]+/gi,
  /\b(?:app_secret|client_secret|access_token|refresh_token)\b\s*[=:]\s*["']?[^\s,"']+/gi,
];

export function redactSecrets(input: string): string {
  return rules.reduce((text, rule) => text.replace(rule, "[REDACTED]"), input);
}
