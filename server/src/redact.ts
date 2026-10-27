/** Replaces known secret strings and keeps log lines short. */
export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('<redacted>');
  }
  return out.slice(0, 2000);
}
