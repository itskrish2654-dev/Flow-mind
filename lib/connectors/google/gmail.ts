import {
  executeGmailReplyToEmail,
  executeGmailSendEmail,
  type GmailActionDependencies,
} from "@/lib/connectors/google/gmail-action-core";
import { googleApiFetch } from "@/lib/connectors/google/api";
import { GOOGLE_SCOPES } from "@/lib/connectors/google/scopes";
import type { ConnectorActionContext, ConnectorActionHandler } from "@/lib/connectors/types";
import { captureOperationalEvent } from "@/lib/observability";
export { htmlToSafeText, normalizeGmailMessage } from "@/lib/connectors/google/gmail-message";

function connectionId(context: ConnectorActionContext) {
  if (!context.connectionId) throw new Error("Google connection is unavailable.");
  return context.connectionId;
}

function dependencies(sendScopes: string[]): GmailActionDependencies {
  return {
    readMessage: async ({ messageId, context, onDispatch }) => {
      const response = await googleApiFetch({
        userId: context.userId,
        connectionId: connectionId(context),
        requiredScopes: [GOOGLE_SCOPES.gmailReadonly],
        url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Subject&metadataHeaders=Reply-To&metadataHeaders=From`,
        dispatchMode: "read",
        onDispatch,
        signal: context.signal,
      });
      return response.json();
    },
    sendMessage: async ({ raw, threadId, context, onDispatch }) => {
      const response = await googleApiFetch({
        userId: context.userId,
        connectionId: connectionId(context),
        requiredScopes: sendScopes,
        url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        method: "POST",
        body: { ...(threadId ? { threadId } : {}), raw },
        dispatchMode: "side_effect",
        onDispatch,
        signal: context.signal,
      });
      return response.json();
    },
  };
}

async function recordGmailAction(
  operation: "send_email" | "reply_to_email",
  context: ConnectorActionContext,
  result: Awaited<ReturnType<typeof executeGmailSendEmail>>,
) {
  try {
    await captureOperationalEvent({
      level: result.status === "succeeded" ? "info" : "warn",
      event: result.status === "succeeded" ? "gmail_action_success" : "gmail_action_failure",
      userId: context.userId,
      workflowId: context.workflowId,
      executionId: context.executionId,
      stepId: context.stepId,
      status: result.status,
      errorCategory: result.error?.category,
      metadata: {
        operation,
        providerReadDispatched: result.metadata.provider_read_dispatched === true,
        sideEffectDispatched: result.metadata.side_effect_dispatched === true,
        externalResultAmbiguous: result.metadata.external_result_ambiguous === true,
      },
    });
  } catch {
    // Provider truth must not be replaced by a telemetry persistence failure.
  }
}

export const gmailSendEmail: ConnectorActionHandler = async (input, context) => {
  const result = await executeGmailSendEmail(
    input,
    context,
    dependencies([GOOGLE_SCOPES.gmailSend]),
  );
  await recordGmailAction("send_email", context, result);
  return result;
};

export const gmailReplyToEmail: ConnectorActionHandler = async (input, context) => {
  const result = await executeGmailReplyToEmail(
    input,
    context,
    dependencies([GOOGLE_SCOPES.gmailReadonly, GOOGLE_SCOPES.gmailSend]),
  );
  await recordGmailAction("reply_to_email", context, result);
  return result;
};
