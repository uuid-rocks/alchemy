/**
 * Shared scaffolding for the AI proxy bindings: each grants `read` on the
 * bound AI secret, which lets the proxy use that provider key. Lives in
 * `internal/`, so the published package doesn't expose it.
 */
import type { AiSecret } from "../AiSecret.ts";
import type { Grant } from "../BraintrustBindings.ts";

export const aiSecretId = (secret: AiSecret) => secret.aiSecretId;

export const AI_SECRET_READ: Grant = { objectType: "ai_secret", permission: "read" };
