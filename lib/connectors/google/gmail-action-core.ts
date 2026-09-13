import { ConnectorError } from "@/lib/connectors/errors";
import {
  buildRawGmailMessage,
  GmailMessageValidationError,
  gmailHeader,
  gmailMessageIdForIdempotencyKey,
  MAX_GMAIL_SUBJECT_BYTES,
  parseGmailRecipients,
  requireGmailBody,
  requireGmailMessageIdHeader,
  requireGmailReferences,
  requireGmailResourceId,
  safeGmailHeader,
} from "@/lib/connectors/google/gmail-message";
import type {
  ConnectorActionContext,
  ConnectorActionResult,
  ConnectorErrorShape,
} from "@/lib/connectors/types";

type DispatchMarker = () => void;

export type GmailActionDependencies = {
  buildMessage?: typeof buildRawGmailMessage;
  readMessage: (input: {
    messageId: string;
    context: ConnectorActionContext;
    onDispatch: DispatchMarker;
  }) => Promise<unknown>;
  sendMessage: (input: {
    raw: string;
    threadId?: string;
    context: ConnectorActionContext;
    onDispatch: DispatchMarker;
  }) => Promise<unknown>;
};

type GmailDispatchState = {
  providerReadDispatched: boolean;
  sideEffectDispatched: boolean;
};

function failureMetadata(operation: "send_email" | "reply_to_email", state: GmailDispatchState, ambiguous: boolean) {
  return {
    operation,
    provider_read_dispatched: state.providerReadDispatched,
    side_effect_dispatched: state.sideEffectDispatched,
    external_result_ambiguous: ambiguous,
    provider_may_have_acted: ambiguous,
  };
}

function validationDetails(error: GmailMessageValidationError): ConnectorErrorShape {
  return {
    category: "validation",
    code: error.code,
    message: error.message,
    retryable: false,
  };
}

function safeFailure(
  operation: "send_email" | "reply_to_email",
  error: unknown,
  state: GmailDispatchState,
): ConnectorActionResult {
  let details: ConnectorErrorShape;
  if (error instanceof GmailMessageValidationError) {
    details = validationDetails(error);
  } else if (error instanceof ConnectorError) {
    details = state.sideEffectDispatched
      ? { ...error.details, retryable: false }
      : error.details;
  } else if (state.sideEffectDispatched) {
    details = {
      category: "ambiguous_acknowledgement",
      code: operation === "send_email" ? "GMAIL_SEND_RESULT_UNKNOWN" : "GMAIL_REPLY_RESULT_UNKNOWN",
      message: operation === "send_email"
        ? "Gmail did not return a conclusive send acknowledgement; the email may have been sent."
        : "Gmail did not return a conclusive reply acknowledgement; the reply may have been sent.",
      retryable: false,
    };
  } else {
    details = {
      category: "internal",
      code: operation === "send_email" ? "GMAIL_SEND_PREPARATION_FAILED" : "GMAIL_REPLY_PREPARATION_FAILED",
      message: operation === "send_email"
        ? "The Gmail email could not be prepared."
        : "The Gmail reply could not be prepared.",
      retryable: false,
    };
  }
  const ambiguous = details.category === "ambiguous_acknowledgement";
  return {
    status: ambiguous ? "ambiguous" : "failed",
    acknowledged: false,
    externallyDelivered: false,
    output: {},
    metadata: failureMetadata(operation, state, ambiguous),
    error: details,
  };
}

function requireConnection(context: ConnectorActionContext, operation: "send_email" | "reply_to_email") {
  if (!context.connectionId) {
    throw new ConnectorError({
      category: "authentication",
      code: "GMAIL_CONNECTION_REQUIRED",
      message: operation === "send_email"
        ? "Choose a Google account before sending email."
        : "Choose a Google account before replying.",
      retryable: false,
    });
  }
}

function providerObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Gmail provider response.");
  }
  return value as Record<string, unknown>;
}

function providerMessageId(value: unknown) {
  try {
    return requireGmailResourceId(value, "Gmail message acknowledgement");
  } catch {
    throw new Error("Gmail did not return a valid message acknowledgement.");
  }
}

function providerThreadId(value: unknown) {
  try {
    return requireGmailResourceId(value, "Gmail thread acknowledgement");
  } catch {
    throw new Error("Gmail did not return a valid thread acknowledgement.");
  }
}

function replyAddress(headers: Array<{ name?: string; value?: string }>) {
  const value = gmailHeader(headers, "Reply-To") || gmailHeader(headers, "From");
  const safeValue = safeGmailHeader(value, "Reply recipient");
  const angleAddress = safeValue.match(/^[^<>]*<([^<>]+)>$/)?.[1];
  if (angleAddress) return angleAddress;
  if (/[<>]/.test(safeValue)) {
    throw new GmailMessageValidationError(
      "GMAIL_RECIPIENT_INVALID",
      "Reply recipient contains an invalid address.",
    );
  }
  return safeValue;
}

export async function executeGmailSendEmail(
  input: Record<string, unknown>,
  context: ConnectorActionContext,
  dependencies: GmailActionDependencies,
): Promise<ConnectorActionResult> {
  const state: GmailDispatchState = { providerReadDispatched: false, sideEffectDispatched: false };
  try {
    requireConnection(context, "send_email");
    const recipients = parseGmailRecipients({ to: input.to, cc: input.cc, bcc: input.bcc });
    const subject = safeGmailHeader(input.subject, "Subject", { maxBytes: MAX_GMAIL_SUBJECT_BYTES });
    const body = requireGmailBody(input.body);
    const messageId = gmailMessageIdForIdempotencyKey(context.idempotencyKey);
    const raw = (dependencies.buildMessage ?? buildRawGmailMessage)({
      ...recipients,
      subject,
      body,
      messageId,
    });
    const response = providerObject(await dependencies.sendMessage({
      raw,
      context,
      onDispatch: () => { state.sideEffectDispatched = true; },
    }));
    const providerReferenceId = providerMessageId(response.id);
    const threadId = response.threadId === undefined || response.threadId === ""
      ? ""
      : providerThreadId(response.threadId);
    return {
      status: "succeeded",
      acknowledged: true,
      externallyDelivered: true,
      providerReferenceId,
      output: { messageId: providerReferenceId, threadId },
      metadata: {
        operation: "send_email",
        provider_read_dispatched: false,
        side_effect_dispatched: true,
        external_result_ambiguous: false,
        provider_may_have_acted: false,
      },
    };
  } catch (error) {
    return safeFailure("send_email", error, state);
  }
}

export async function executeGmailReplyToEmail(
  input: Record<string, unknown>,
  context: ConnectorActionContext,
  dependencies: GmailActionDependencies,
): Promise<ConnectorActionResult> {
  const state: GmailDispatchState = { providerReadDispatched: false, sideEffectDispatched: false };
  try {
    requireConnection(context, "reply_to_email");
    const messageId = requireGmailResourceId(input.messageId, "Gmail message");
    const threadId = requireGmailResourceId(input.threadId, "Gmail thread");
    const body = requireGmailBody(input.body);
    const explicitRecipients = input.to === undefined || input.to === ""
      ? null
      : parseGmailRecipients({ to: input.to });
    const explicitSubject = input.subject === undefined || input.subject === ""
      ? null
      : safeGmailHeader(input.subject, "Subject", { maxBytes: MAX_GMAIL_SUBJECT_BYTES });
    const outboundMessageId = gmailMessageIdForIdempotencyKey(context.idempotencyKey);

    const source = providerObject(await dependencies.readMessage({
      messageId,
      context,
      onDispatch: () => { state.providerReadDispatched = true; },
    }));
    if (source.threadId !== threadId) {
      throw new GmailMessageValidationError(
        "GMAIL_REPLY_THREAD_MISMATCH",
        "The Gmail message does not belong to the selected thread.",
      );
    }
    const payload = providerObject(source.payload);
    if (!Array.isArray(payload.headers)) {
      throw new Error("Gmail reply metadata is unavailable.");
    }
    const headers = payload.headers.filter(
      (header): header is { name?: string; value?: string } => Boolean(header && typeof header === "object"),
    );
    const originalMessageId = requireGmailMessageIdHeader(
      gmailHeader(headers, "Message-ID"),
      "Original Message-ID",
    );
    const recipients = explicitRecipients ?? parseGmailRecipients({ to: replyAddress(headers) });
    const originalSubject = gmailHeader(headers, "Subject");
    const subject = explicitSubject ?? safeGmailHeader(
      /^re:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`,
      "Subject",
      { maxBytes: MAX_GMAIL_SUBJECT_BYTES },
    );
    const priorReferences = requireGmailReferences(gmailHeader(headers, "References"));
    const references = requireGmailReferences([priorReferences, originalMessageId].filter(Boolean).join(" "));
    const raw = (dependencies.buildMessage ?? buildRawGmailMessage)({
      ...recipients,
      subject,
      body,
      messageId: outboundMessageId,
      inReplyTo: originalMessageId,
      references,
    });
    const response = providerObject(await dependencies.sendMessage({
      raw,
      threadId,
      context,
      onDispatch: () => { state.sideEffectDispatched = true; },
    }));
    const providerReferenceId = providerMessageId(response.id);
    const acknowledgedThreadId = providerThreadId(response.threadId);
    if (acknowledgedThreadId !== threadId) {
      throw new Error("Gmail did not acknowledge the reply in the requested thread.");
    }
    return {
      status: "succeeded",
      acknowledged: true,
      externallyDelivered: true,
      providerReferenceId,
      output: { messageId: providerReferenceId, threadId },
      metadata: {
        operation: "reply_to_email",
        provider_read_dispatched: true,
        side_effect_dispatched: true,
        external_result_ambiguous: false,
        provider_may_have_acted: false,
      },
    };
  } catch (error) {
    return safeFailure("reply_to_email", error, state);
  }
}
