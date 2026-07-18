// Classify a failed WhatsApp send. A RECIPIENT failure (the number is not on
// WhatsApp / invalid / blocked) is the recipient's fault and counts toward the
// give-up cap. Everything else is treated as a TRANSIENT infra failure (the
// Evolution host waking/restarting/timed-out, a 5xx, a reconnect, or an unknown/
// empty error from a dead host) - it must NOT burn the retry cap or creep the
// ETA, so a batch resumes the moment the host recovers instead of stalling.

export function isRecipientSendFailure(error?: string | null): boolean {
  return /not.*whatsapp|invalid|exist|blocked|forbidden|no-?phone/i.test(String(error ?? ""));
}

export function isTransientSendFailure(error?: string | null): boolean {
  return !isRecipientSendFailure(error);
}
