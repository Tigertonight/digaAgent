const SECRET_VALUE = "***";

const SECRET_KEY =
  "(?:authorization|proxy-authorization|cookie|set-cookie|token|access[_-]?token|refresh[_-]?token|secret|password|passwd|api[_-]?key|apikey|x-api-key|x-[\\w-]*-key|client[_-]?secret|private[_-]?key)";

export function redactSecrets(input: string): string {
  if (!input) return input;
  let text = input;
  text = text.replace(
    /(\bAuthorization\s*:\s*Bearer\s+)([A-Za-z0-9._~+/=-]+)/gi,
    `$1${SECRET_VALUE}`,
  );
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${SECRET_VALUE}`);
  text = text.replace(
    new RegExp(`([?&])(${SECRET_KEY})=([^&#\\s'"]+)`, "gi"),
    (_match, sep, key) => `${sep}${key}=${SECRET_VALUE}`,
  );
  text = text.replace(
    new RegExp(`\\b(${SECRET_KEY})\\s*[:=]\\s*([^\\s"'\\]}),;]+)`, "gi"),
    (_match, key) => `${key}: ${SECRET_VALUE}`,
  );
  text = text.replace(
    new RegExp(`(--${SECRET_KEY})\\s+(?:"[^"]*"|'[^']*'|\\S+)`, "gi"),
    (_match, key) => `${key} ${SECRET_VALUE}`,
  );
  text = text.replace(/\bAKIA[0-9A-Z]{16}\b/g, `AKIA${SECRET_VALUE}`);
  text = text.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, `sk-${SECRET_VALUE}`);
  text = text.replace(
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    `jwt.${SECRET_VALUE}`,
  );
  text = text.replace(
    /-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g,
    `-----BEGIN PRIVATE KEY-----\n${SECRET_VALUE}\n-----END PRIVATE KEY-----`,
  );
  return text;
}
