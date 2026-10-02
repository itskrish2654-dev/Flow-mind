export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  public: {
    Tables: {
      knowledge_documents: {
        Row: {
          id: string; workspace_id: string; uploaded_by_user_id: string | null;
          title: string; filename: string; mime_type: string; size_bytes: number;
          sha256: string; storage_path: string;
          status: "processing" | "ready" | "failed" | "deleting";
          page_count: number | null; character_count: number | null;
          chunk_count: number | null; failure_reason: string | null;
          created_at: string; updated_at: string;
        };
        Insert: {
          id?: string; workspace_id: string; uploaded_by_user_id?: string | null;
          title: string; filename: string; mime_type: string; size_bytes: number;
          sha256: string; storage_path: string;
          status?: "processing" | "ready" | "failed" | "deleting";
          page_count?: number | null; character_count?: number | null;
          chunk_count?: number | null; failure_reason?: string | null;
          created_at?: string; updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["knowledge_documents"]["Insert"]>;
        Relationships: [];
      };
      knowledge_chunks: {
        Row: {
          id: string; workspace_id: string; document_id: string;
          chunk_index: number; page_number: number | null; content: string;
          search_vector: unknown;
        };
        Insert: {
          id?: string; workspace_id: string; document_id: string;
          chunk_index: number; page_number?: number | null; content: string;
        };
        Update: Record<PropertyKey, never>;
        Relationships: [];
      };
      activity_events: {
        Row: {
          id: number;
          workspace_id: string;
          owner_user_id: string;
          actor_user_id: string | null;
          visibility: "private" | "workspace";
          event_type: string;
          source_type: "work_item" | "approval" | "action" | "workflow_execution";
          source_id: string;
          work_item_id: string | null;
          approval_request_id: string | null;
          action_execution_id: string | null;
          workflow_id: string | null;
          event_key: string;
          occurred_at: string;
        };
        Insert: {
          workspace_id: string;
          owner_user_id: string;
          actor_user_id?: string | null;
          visibility: "private" | "workspace";
          event_type: string;
          source_type: "work_item" | "approval" | "action" | "workflow_execution";
          source_id: string;
          work_item_id?: string | null;
          approval_request_id?: string | null;
          action_execution_id?: string | null;
          workflow_id?: string | null;
          event_key: string;
          occurred_at?: string;
        };
        Update: Record<PropertyKey, never>;
        Relationships: [];
      };
      ask_threads: {
        Row: {
          id: string;
          workspace_id: string;
          user_id: string;
          title: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          user_id: string;
          title: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          title?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      ask_messages: {
        Row: {
          id: string;
          thread_id: string;
          workspace_id: string;
          user_id: string;
          role: "user" | "assistant";
          content: string;
          response_metadata: Json | null;
          turn_id: string | null;
          turn_position: number | null;
          sequence_no: number | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          thread_id: string;
          workspace_id: string;
          user_id: string;
          role: "user" | "assistant";
          content: string;
          response_metadata?: Json | null;
          turn_id?: string | null;
          turn_position?: number | null;
          sequence_no?: number | null;
          created_at?: string;
        };
        Update: Record<string, never>;
        Relationships: [];
      };
      ask_turns: {
        Row: {
          id: string;
          workspace_id: string;
          thread_id: string;
          user_id: string;
          request_id: string;
          question: string;
          state: "processing" | "completed" | "failed";
          turn_sequence: number;
          attempt_generation: number;
          attempt_token: string | null;
          lease_until: string | null;
          failure_category: string | null;
          created_at: string;
          updated_at: string;
          completed_at: string | null;
          failed_at: string | null;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          thread_id: string;
          user_id: string;
          request_id: string;
          question: string;
          state?: "processing" | "completed" | "failed";
          turn_sequence: number;
          attempt_generation?: number;
          attempt_token?: string | null;
          lease_until?: string | null;
          failure_category?: string | null;
          created_at?: string;
          updated_at?: string;
          completed_at?: string | null;
          failed_at?: string | null;
        };
        Update: {
          state?: "processing" | "completed" | "failed";
          attempt_generation?: number;
          attempt_token?: string | null;
          lease_until?: string | null;
          failure_category?: string | null;
          updated_at?: string;
          completed_at?: string | null;
          failed_at?: string | null;
        };
        Relationships: [];
      };
      workspaces: {
        Row: {
          id: string;
          name: string;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name?: string;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          name?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      workspace_memberships: {
        Row: {
          workspace_id: string;
          user_id: string;
          role: "owner" | "admin" | "member";
          is_default: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          workspace_id: string;
          user_id: string;
          role: "owner" | "admin" | "member";
          is_default?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          role?: "owner" | "admin" | "member";
          is_default?: boolean;
          updated_at?: string;
        };
        Relationships: [];
      };
      workspace_invitations: {
        Row: {
          id: string;
          workspace_id: string;
          invited_email: string;
          normalized_email: string;
          intended_role: "admin" | "member";
          status: "pending" | "accepted" | "revoked" | "expired";
          token_hash: string;
          created_by: string | null;
          accepted_by: string | null;
          revoked_by: string | null;
          created_at: string;
          updated_at: string;
          expires_at: string;
          accepted_at: string | null;
          revoked_at: string | null;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          invited_email: string;
          normalized_email: string;
          intended_role: "admin" | "member";
          status?: "pending" | "accepted" | "revoked" | "expired";
          token_hash: string;
          created_by?: string | null;
          accepted_by?: string | null;
          revoked_by?: string | null;
          created_at?: string;
          updated_at?: string;
          expires_at: string;
          accepted_at?: string | null;
          revoked_at?: string | null;
        };
        Update: {
          status?: "pending" | "accepted" | "revoked" | "expired";
          accepted_by?: string | null;
          revoked_by?: string | null;
          updated_at?: string;
          accepted_at?: string | null;
          revoked_at?: string | null;
        };
        Relationships: [];
      };
      work_items: {
        Row: {
          id: string;
          workspace_id: string;
          assignee_user_id: string;
          title: string;
          summary: string | null;
          why_it_matters: string | null;
          suggested_action: string | null;
          status: "needs_you" | "waiting" | "handled" | "done";
          priority: "low" | "normal" | "high";
          due_at: string | null;
          source_type: "workflow" | "workflow_execution" | "connector_event" | "system" | "internal";
          source_id: string | null;
          source_label: string | null;
          dedupe_key: string | null;
          created_at: string;
          updated_at: string;
          resolved_at: string | null;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          assignee_user_id: string;
          title: string;
          summary?: string | null;
          why_it_matters?: string | null;
          suggested_action?: string | null;
          status?: "needs_you" | "waiting" | "handled" | "done";
          priority?: "low" | "normal" | "high";
          due_at?: string | null;
          source_type: "workflow" | "workflow_execution" | "connector_event" | "system" | "internal";
          source_id?: string | null;
          source_label?: string | null;
          dedupe_key?: string | null;
          created_at?: string;
          updated_at?: string;
          resolved_at?: string | null;
        };
        Update: {
          status?: "needs_you" | "waiting" | "handled" | "done";
          updated_at?: string;
          resolved_at?: string | null;
        };
        Relationships: [];
      };
      approval_requests: {
        Row: {
          id: string;
          workspace_id: string;
          work_item_id: string;
          approver_user_id: string;
          requested_by_user_id: string | null;
          origin_type: "workflow" | "workflow_execution" | "connector_event" | "system" | "internal";
          source_id: string | null;
          request_key: string;
          action_title: string;
          action_summary: string;
          approval_reason: string;
          capability_id: string;
          action_snapshot: Json;
          status: "pending" | "approved" | "rejected" | "cancelled";
          decided_by_user_id: string | null;
          decided_at: string | null;
          rejection_reason: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          work_item_id: string;
          approver_user_id: string;
          requested_by_user_id?: string | null;
          origin_type: "workflow" | "workflow_execution" | "connector_event" | "system" | "internal";
          source_id?: string | null;
          request_key: string;
          action_title: string;
          action_summary: string;
          approval_reason: string;
          capability_id: string;
          action_snapshot: Json;
          status?: "pending" | "approved" | "rejected" | "cancelled";
          decided_by_user_id?: string | null;
          decided_at?: string | null;
          rejection_reason?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          status?: "approved" | "rejected" | "cancelled";
          decided_by_user_id?: string;
          decided_at?: string;
          rejection_reason?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      action_executions: {
        Row: {
          id: string;
          workspace_id: string;
          requester_user_id: string;
          approval_request_id: string;
          work_item_id: string;
          source_message_id: string | null;
          connection_id: string | null;
          capability_id: string;
          connector_id: string;
          operation_key: string;
          operation_version: number;
          idempotency_key: string;
          status: "pending_approval" | "queued" | "executing" | "succeeded" | "failed" | "ambiguous" | "rejected" | "cancelled";
          claim_token: string | null;
          claimed_at: string | null;
          attempt_count: number;
          acknowledged: boolean;
          externally_delivered: boolean;
          provider_reference_id: string | null;
          result_summary: string | null;
          failure_category: string | null;
          failure_message: string | null;
          created_at: string;
          updated_at: string;
          completed_at: string | null;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          requester_user_id: string;
          approval_request_id: string;
          work_item_id: string;
          source_message_id?: string | null;
          connection_id?: string | null;
          capability_id: string;
          connector_id: string;
          operation_key: string;
          operation_version: number;
          idempotency_key: string;
          status?: "pending_approval" | "queued" | "executing" | "succeeded" | "failed" | "ambiguous" | "rejected" | "cancelled";
          claim_token?: string | null;
          claimed_at?: string | null;
          attempt_count?: number;
          acknowledged?: boolean;
          externally_delivered?: boolean;
          provider_reference_id?: string | null;
          result_summary?: string | null;
          failure_category?: string | null;
          failure_message?: string | null;
          created_at?: string;
          updated_at?: string;
          completed_at?: string | null;
        };
        Update: {
          status?: "pending_approval" | "queued" | "executing" | "succeeded" | "failed" | "ambiguous" | "rejected" | "cancelled";
          claim_token?: string | null;
          claimed_at?: string | null;
          attempt_count?: number;
          acknowledged?: boolean;
          externally_delivered?: boolean;
          provider_reference_id?: string | null;
          result_summary?: string | null;
          failure_category?: string | null;
          failure_message?: string | null;
          updated_at?: string;
          completed_at?: string | null;
        };
        Relationships: [];
      };
      workflows: {
        Row: {
          id: string;
          user_id: string;
          workspace_id: string;
          name: string;
          prompt: string;
          compiled_steps: Json | null;
          public_form_enabled: boolean;
          published_at: string | null;
          public_form_challenge_mode: "honeypot" | "turnstile";
          created_at: string;
          updated_at: string;
          current_version_id: string | null;
          published_version_id: string | null;
          lifecycle_state: "active" | "disabled" | "archived";
          archived_at: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          workspace_id?: string;
          name: string;
          prompt: string;
          compiled_steps?: Json | null;
          public_form_enabled?: boolean;
          published_at?: string | null;
          public_form_challenge_mode?: "honeypot" | "turnstile";
          created_at?: string;
          updated_at?: string;
          current_version_id?: string | null;
          published_version_id?: string | null;
          lifecycle_state?: "active" | "disabled" | "archived";
          archived_at?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          workspace_id?: string;
          name?: string;
          prompt?: string;
          compiled_steps?: Json | null;
          public_form_enabled?: boolean;
          published_at?: string | null;
          public_form_challenge_mode?: "honeypot" | "turnstile";
          created_at?: string;
          updated_at?: string;
          current_version_id?: string | null;
          published_version_id?: string | null;
          lifecycle_state?: "active" | "disabled" | "archived";
          archived_at?: string | null;
        };
        Relationships: [];
      };
      workflow_versions: {
        Row: {
          id: string;
          workflow_id: string;
          user_id: string;
          version_number: number;
          compiled_workflow: Json;
          setup_config: Json;
          change_scope: string;
          change_summary: string | null;
          source_version_id: string | null;
          created_by: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          workflow_id: string;
          user_id: string;
          version_number: number;
          compiled_workflow: Json;
          setup_config?: Json;
          change_scope?: string;
          change_summary?: string | null;
          source_version_id?: string | null;
          created_by: string;
          created_at?: string;
        };
        Update: never;
        Relationships: [];
      };
      workflow_credentials: {
        Row: {
          id: string;
          user_id: string;
          workflow_id: string;
          connector_id: string;
          credential_key: string;
          credential_type: string;
          ciphertext: string;
          nonce: string;
          auth_tag: string;
          encryption_version: number;
          algorithm: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          workflow_id: string;
          connector_id: string;
          credential_key: string;
          credential_type: string;
          ciphertext: string;
          nonce: string;
          auth_tag: string;
          encryption_version?: number;
          algorithm?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          ciphertext?: string;
          nonce?: string;
          auth_tag?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      connector_connections: {
        Row: { id: string; user_id: string; workspace_id: string; connector_id: string; provider_family: string; external_account_id: string; external_account_label: string | null; auth_type: "none" | "api_key" | "oauth2"; status: "connected" | "expired" | "revoked" | "error"; granted_scopes: string[]; token_expires_at: string | null; last_refreshed_at: string | null; last_error_category: string | null; safe_metadata: Json; created_at: string; updated_at: string };
        Insert: { id?: string; user_id: string; workspace_id?: string; connector_id: string; provider_family: string; external_account_id: string; external_account_label?: string | null; auth_type: "none" | "api_key" | "oauth2"; status?: "connected" | "expired" | "revoked" | "error"; granted_scopes?: string[]; token_expires_at?: string | null; last_refreshed_at?: string | null; last_error_category?: string | null; safe_metadata?: Json; created_at?: string; updated_at?: string };
        Update: { workspace_id?: string; external_account_label?: string | null; status?: "connected" | "expired" | "revoked" | "error"; granted_scopes?: string[]; token_expires_at?: string | null; last_refreshed_at?: string | null; last_error_category?: string | null; safe_metadata?: Json; updated_at?: string };
        Relationships: [];
      };
      google_selected_spreadsheets: {
        Row: { id: string; user_id: string; connection_id: string; spreadsheet_id: string; display_name: string; mime_type: string; selected_at: string; last_validated_at: string };
        Insert: { id?: string; user_id: string; connection_id: string; spreadsheet_id: string; display_name: string; mime_type?: string; selected_at?: string; last_validated_at?: string };
        Update: { display_name?: string; mime_type?: string; selected_at?: string; last_validated_at?: string };
        Relationships: [];
      };
      connector_connection_credentials: {
        Row: { id: string; connection_id: string; user_id: string; credential_key: string; credential_type: string; ciphertext: string; nonce: string; auth_tag: string; encryption_version: number; algorithm: string; created_at: string; updated_at: string };
        Insert: { id?: string; connection_id: string; user_id: string; credential_key: string; credential_type: string; ciphertext: string; nonce: string; auth_tag: string; encryption_version?: number; algorithm?: string; created_at?: string; updated_at?: string };
        Update: { ciphertext?: string; nonce?: string; auth_tag?: string; updated_at?: string };
        Relationships: [];
      };
      connector_oauth_states: {
        Row: { state_hash: string; user_id: string; connector_id: string; provider_family: string; requested_scopes: string[]; return_path: string; pkce_ciphertext: string; pkce_nonce: string; pkce_auth_tag: string; intended_connection_id: string | null; operation_key: string | null; expires_at: string; consumed_at: string | null; created_at: string };
        Insert: { state_hash: string; user_id: string; connector_id: string; provider_family: string; requested_scopes?: string[]; return_path: string; pkce_ciphertext: string; pkce_nonce: string; pkce_auth_tag: string; intended_connection_id?: string | null; operation_key?: string | null; expires_at: string; consumed_at?: string | null; created_at?: string };
        Update: { consumed_at?: string | null };
        Relationships: [];
      };
      connector_subscriptions: {
        Row: { id: string; user_id: string; workflow_id: string; workflow_version_id: string; connection_id: string | null; connector_id: string; operation_key: string; operation_version: number; provider_subscription_id: string | null; endpoint_token_hash: string | null; status: "active" | "paused" | "expired" | "revoked" | "error"; cursor_value: string | null; renew_after: string | null; expires_at: string | null; last_event_at: string | null; last_error_category: string | null; safe_metadata: Json; created_at: string; updated_at: string };
        Insert: { id?: string; user_id: string; workflow_id: string; workflow_version_id: string; connection_id?: string | null; connector_id: string; operation_key: string; operation_version: number; provider_subscription_id?: string | null; endpoint_token_hash?: string | null; status?: "active" | "paused" | "expired" | "revoked" | "error"; cursor_value?: string | null; renew_after?: string | null; expires_at?: string | null; last_event_at?: string | null; last_error_category?: string | null; safe_metadata?: Json; created_at?: string; updated_at?: string };
        Update: { status?: "active" | "paused" | "expired" | "revoked" | "error"; provider_subscription_id?: string | null; endpoint_token_hash?: string | null; cursor_value?: string | null; renew_after?: string | null; expires_at?: string | null; last_event_at?: string | null; last_error_category?: string | null; safe_metadata?: Json; updated_at?: string };
        Relationships: [];
      };
      connector_event_receipts: {
        Row: { id: string; subscription_id: string; workflow_id: string; workflow_version_id: string; provider_event_key: string; status: "queued" | "processing" | "succeeded" | "failed" | "duplicate"; payload: Json; safe_metadata: Json; execution_id: string | null; received_at: string; processed_at: string | null; expires_at: string };
        Insert: { id?: string; subscription_id: string; workflow_id: string; workflow_version_id: string; provider_event_key: string; status?: "queued" | "processing" | "succeeded" | "failed" | "duplicate"; payload: Json; safe_metadata?: Json; execution_id?: string | null; received_at?: string; processed_at?: string | null; expires_at?: string };
        Update: { status?: "queued" | "processing" | "succeeded" | "failed" | "duplicate"; safe_metadata?: Json; execution_id?: string | null; processed_at?: string | null };
        Relationships: [];
      };
      gmail_ingestion_states: {
        Row: { connection_id: string; user_id: string; processed_history_id: string; observed_history_id: string; status: "idle" | "pending" | "processing" | "resync_required" | "reconnect_required"; lease_token: string | null; lease_until: string | null; next_attempt_at: string; attempt_count: number; last_error_category: string | null; next_poll_at: string; last_polled_at: string | null; poll_lease_token: string | null; poll_lease_until: string | null; poll_error_category: string | null; created_at: string; updated_at: string };
        Insert: { connection_id: string; user_id: string; processed_history_id: string; observed_history_id: string; status?: "idle" | "pending" | "processing" | "resync_required" | "reconnect_required"; lease_token?: string | null; lease_until?: string | null; next_attempt_at?: string; attempt_count?: number; last_error_category?: string | null; next_poll_at?: string; last_polled_at?: string | null; poll_lease_token?: string | null; poll_lease_until?: string | null; poll_error_category?: string | null; created_at?: string; updated_at?: string };
        Update: { processed_history_id?: string; observed_history_id?: string; status?: "idle" | "pending" | "processing" | "resync_required" | "reconnect_required"; lease_token?: string | null; lease_until?: string | null; next_attempt_at?: string; attempt_count?: number; last_error_category?: string | null; next_poll_at?: string; last_polled_at?: string | null; poll_lease_token?: string | null; poll_lease_until?: string | null; poll_error_category?: string | null; updated_at?: string };
        Relationships: [];
      };
      gmail_push_receipts: {
        Row: { id: string; connection_id: string; user_id: string; pubsub_subscription: string; pubsub_message_id: string; history_id: string; publish_time: string | null; status: "queued" | "succeeded" | "rejected"; attempt_count: number; last_error_category: string | null; received_at: string; processed_at: string | null; expires_at: string };
        Insert: { id?: string; connection_id: string; user_id: string; pubsub_subscription: string; pubsub_message_id: string; history_id: string; publish_time?: string | null; status?: "queued" | "succeeded" | "rejected"; attempt_count?: number; last_error_category?: string | null; received_at?: string; processed_at?: string | null; expires_at?: string };
        Update: { status?: "queued" | "succeeded" | "rejected"; attempt_count?: number; last_error_category?: string | null; processed_at?: string | null };
        Relationships: [];
      };
      connector_provider_setup_secrets: {
        Row: { provider: string; ciphertext: string; nonce: string; auth_tag: string; encryption_version: number; algorithm: string; created_at: string; expires_at: string };
        Insert: { provider: string; ciphertext: string; nonce: string; auth_tag: string; encryption_version?: number; algorithm?: string; created_at?: string; expires_at: string };
        Update: never;
        Relationships: [];
      };
      workflow_schedules: {
        Row: { id: string; user_id: string; workflow_id: string; workflow_version_id: string; status: "active" | "disabled" | "completed" | "error"; schedule_definition: Json; human_label: string; timezone: string; anchor_at: string; next_run_at: string | null; last_scheduled_for: string | null; last_dispatched_at: string | null; last_error_category: string | null; created_at: string; updated_at: string };
        Insert: { id?: string; user_id: string; workflow_id: string; workflow_version_id: string; status?: "active" | "disabled" | "completed" | "error"; schedule_definition: Json; human_label: string; timezone: string; anchor_at?: string; next_run_at?: string | null; last_scheduled_for?: string | null; last_dispatched_at?: string | null; last_error_category?: string | null; created_at?: string; updated_at?: string };
        Update: { workflow_version_id?: string; status?: "active" | "disabled" | "completed" | "error"; schedule_definition?: Json; human_label?: string; timezone?: string; anchor_at?: string; next_run_at?: string | null; last_scheduled_for?: string | null; last_dispatched_at?: string | null; last_error_category?: string | null; updated_at?: string };
        Relationships: [];
      };
      workflow_schedule_occurrences: {
        Row: { id: string; schedule_id: string; user_id: string; workflow_id: string; workflow_version_id: string; scheduled_for: string; status: "claimed" | "running" | "succeeded" | "failed" | "missed" | "duplicate"; execution_id: string | null; missed_earlier_count: number; reason: string | null; created_at: string; completed_at: string | null };
        Insert: { id?: string; schedule_id: string; user_id: string; workflow_id: string; workflow_version_id: string; scheduled_for: string; status: "claimed" | "running" | "succeeded" | "failed" | "missed" | "duplicate"; execution_id?: string | null; missed_earlier_count?: number; reason?: string | null; created_at?: string; completed_at?: string | null };
        Update: { status?: "claimed" | "running" | "succeeded" | "failed" | "missed" | "duplicate"; execution_id?: string | null; reason?: string | null; completed_at?: string | null };
        Relationships: [];
      };
      connector_capability_requests: {
        Row: { id: string; requester_hash: string; user_id: string | null; requested_provider: string; requested_capability: string | null; source: "homepage_demo" | "workflow_builder" | "connections_page"; request_count: number; first_requested_at: string; last_requested_at: string };
        Insert: { id?: string; requester_hash: string; user_id?: string | null; requested_provider: string; requested_capability?: string | null; source: "homepage_demo" | "workflow_builder" | "connections_page"; request_count?: number; first_requested_at?: string; last_requested_at?: string };
        Update: { request_count?: number; last_requested_at?: string };
        Relationships: [];
      };
      generated_document_records: {
        Row: {
          id: string;
          user_id: string;
          workflow_id: string;
          storage_path: string;
          filename: string;
          content_type: string;
          size_bytes: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          workflow_id: string;
          storage_path: string;
          filename: string;
          content_type?: string;
          size_bytes: number;
          created_at?: string;
        };
        Update: never;
        Relationships: [];
      };
      security_rate_limits: {
        Row: {
          key_hash: string;
          request_count: number;
          window_started_at: string;
          window_seconds: number;
          updated_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      usage_counters: {
        Row: {
          user_id: string;
          metric: string;
          period_started_at: string;
          used: number;
          updated_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      security_concurrency_leases: {
        Row: {
          key_hash: string;
          lease_id: string;
          expires_at: string;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      account_deletion_jobs: {
        Row: {
          id: string;
          user_id: string;
          state: "requested" | "processing" | "completed" | "failed";
          requested_at: string;
          started_at: string | null;
          completed_at: string | null;
          updated_at: string;
          retry_count: number;
          failure_code: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          state?: "requested" | "processing" | "completed" | "failed";
          requested_at?: string;
          started_at?: string | null;
          completed_at?: string | null;
          updated_at?: string;
          retry_count?: number;
          failure_code?: string | null;
        };
        Update: {
          state?: "requested" | "processing" | "completed" | "failed";
          started_at?: string | null;
          completed_at?: string | null;
          updated_at?: string;
          retry_count?: number;
          failure_code?: string | null;
        };
        Relationships: [];
      };
      operational_events: {
        Row: {
          id: string;
          occurred_at: string;
          level: "info" | "warn" | "error";
          event: string;
          request_id: string | null;
          user_id_hash: string | null;
          workflow_id: string | null;
          workflow_version_id: string | null;
          execution_id: string | null;
          step_id: string | null;
          capability: string | null;
          duration_ms: number | null;
          status: string | null;
          error_category: string | null;
          environment: string;
          release: string | null;
          metadata: Json;
        };
        Insert: {
          id?: string;
          occurred_at?: string;
          level: "info" | "warn" | "error";
          event: string;
          request_id?: string | null;
          user_id_hash?: string | null;
          workflow_id?: string | null;
          workflow_version_id?: string | null;
          execution_id?: string | null;
          step_id?: string | null;
          capability?: string | null;
          duration_ms?: number | null;
          status?: string | null;
          error_category?: string | null;
          environment?: string;
          release?: string | null;
          metadata?: Json;
        };
        Update: never;
        Relationships: [];
      };
      product_analytics_events: {
        Row: {
          id: string;
          occurred_at: string;
          event_name: string;
          user_id_hash: string | null;
          anonymous_id_hash: string | null;
          workflow_id: string | null;
          environment: string;
          properties: Json;
        };
        Insert: {
          id?: string;
          occurred_at?: string;
          event_name: string;
          user_id_hash?: string | null;
          anonymous_id_hash?: string | null;
          workflow_id?: string | null;
          environment?: string;
          properties?: Json;
        };
        Update: never;
        Relationships: [];
      };
      operational_maintenance_runs: {
        Row: {
          id: string;
          job_name: string;
          started_at: string;
          completed_at: string | null;
          status: "running" | "succeeded" | "failed" | "skipped";
          metrics: Json;
          error_category: string | null;
        };
        Insert: {
          id?: string;
          job_name?: string;
          started_at?: string;
          completed_at?: string | null;
          status: "running" | "succeeded" | "failed" | "skipped";
          metrics?: Json;
          error_category?: string | null;
        };
        Update: {
          completed_at?: string | null;
          status?: "running" | "succeeded" | "failed" | "skipped";
          metrics?: Json;
          error_category?: string | null;
        };
        Relationships: [];
      };
      workflow_executions: {
        Row: {
          id: string;
          workflow_id: string;
          input_data: Json;
          output_data: Json;
          created_at: string;
          workflow_version_id: string | null;
          user_id: string;
          trigger_type: string;
          trigger_metadata: Json;
          idempotency_key: string;
          status: "queued" | "running" | "succeeded" | "partially_failed" | "failed" | "cancelled";
          started_at: string | null;
          completed_at: string | null;
          failure_category: string | null;
          sanitized_metadata: Json;
          attempt_count: number;
        };
        Insert: {
          id?: string;
          workflow_id: string;
          input_data?: Json;
          output_data?: Json;
          created_at?: string;
          workflow_version_id?: string | null;
          user_id: string;
          trigger_type: string;
          trigger_metadata?: Json;
          idempotency_key: string;
          status?: "queued" | "running" | "succeeded" | "partially_failed" | "failed" | "cancelled";
          started_at?: string | null;
          completed_at?: string | null;
          failure_category?: string | null;
          sanitized_metadata?: Json;
          attempt_count?: number;
        };
        Update: {
          id?: string;
          workflow_id?: string;
          input_data?: Json;
          output_data?: Json;
          created_at?: string;
          workflow_version_id?: string | null;
          user_id?: string;
          trigger_type?: string;
          trigger_metadata?: Json;
          idempotency_key?: string;
          status?: "queued" | "running" | "succeeded" | "partially_failed" | "failed" | "cancelled";
          started_at?: string | null;
          completed_at?: string | null;
          failure_category?: string | null;
          sanitized_metadata?: Json;
          attempt_count?: number;
        };
        Relationships: [];
      };
      workflow_execution_steps: {
        Row: {
          id: string;
          execution_id: string;
          workflow_version_id: string;
          workflow_step_id: string;
          step_index: number;
          capability_id: string;
          status: "pending" | "running" | "succeeded" | "failed" | "skipped";
          attempt_number: number;
          started_at: string | null;
          completed_at: string | null;
          sanitized_input_metadata: Json;
          sanitized_output_metadata: Json;
          provider_reference_id: string | null;
          error_category: string | null;
          retryable: boolean | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          execution_id: string;
          workflow_version_id: string;
          workflow_step_id: string;
          step_index: number;
          capability_id: string;
          status?: "pending" | "running" | "succeeded" | "failed" | "skipped";
          attempt_number?: number;
          started_at?: string | null;
          completed_at?: string | null;
          sanitized_input_metadata?: Json;
          sanitized_output_metadata?: Json;
          provider_reference_id?: string | null;
          error_category?: string | null;
          retryable?: boolean | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          status?: "pending" | "running" | "succeeded" | "failed" | "skipped";
          attempt_number?: number;
          started_at?: string | null;
          completed_at?: string | null;
          sanitized_input_metadata?: Json;
          sanitized_output_metadata?: Json;
          provider_reference_id?: string | null;
          error_category?: string | null;
          retryable?: boolean | null;
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      search_company_knowledge: {
        Args: { p_actor_user_id: string; p_workspace_id: string; p_query: string; p_limit?: number };
        Returns: Array<{
          chunk_id: string; document_id: string; document_title: string;
          chunk_index: number; page_number: number | null; content: string; rank: number;
        }>;
      };
      claim_ask_turn: {
        Args: {
          p_actor_user_id: string;
          p_request_id: string;
          p_thread_id: string | null;
          p_question: string;
          p_thread_title: string;
          p_lease_seconds?: number;
        };
        Returns: Array<{
          disposition: string;
          turn_id: string | null;
          resolved_thread_id: string;
          logical_request_id: string;
          submitted_question: string;
          turn_sequence: number | null;
          user_sequence_no: number | null;
          attempt_token: string | null;
          attempt_generation: number | null;
          turn_state: string | null;
          failure_category: string | null;
          assistant_content: string | null;
          assistant_metadata: Json | null;
        }>;
      };
      get_ask_turn_status: {
        Args: { p_actor_user_id: string; p_request_id: string; p_thread_id?: string | null };
        Returns: Database["public"]["Functions"]["claim_ask_turn"]["Returns"];
      };
      retry_ask_turn: {
        Args: { p_actor_user_id: string; p_request_id: string; p_thread_id: string | null; p_lease_seconds?: number };
        Returns: Database["public"]["Functions"]["claim_ask_turn"]["Returns"];
      };
      complete_ask_turn: {
        Args: {
          p_actor_user_id: string;
          p_request_id: string;
          p_attempt_token: string;
          p_attempt_generation: number;
          p_answer: string;
          p_response_metadata: Json;
        };
        Returns: boolean;
      };
      fail_ask_turn: {
        Args: {
          p_actor_user_id: string;
          p_request_id: string;
          p_attempt_token: string;
          p_attempt_generation: number;
          p_failure_category: string;
        };
        Returns: boolean;
      };
      create_approval_request: {
        Args: {
          p_actor_user_id: string;
          p_work_item_id: string;
          p_approver_user_id: string;
          p_origin_type: string;
          p_source_id: string | null;
          p_request_key: string;
          p_action_title: string;
          p_action_summary: string;
          p_approval_reason: string;
          p_capability_id: string;
          p_action_snapshot: Json;
        };
        Returns: Database["public"]["Tables"]["approval_requests"]["Row"][];
      };
      decide_approval_request: {
        Args: {
          p_approval_id: string;
          p_actor_user_id: string;
          p_decision: "approved" | "rejected" | "cancelled";
          p_rejection_reason?: string | null;
        };
        Returns: Database["public"]["Tables"]["approval_requests"]["Row"][];
      };
      create_action_approval: {
        Args: {
          p_actor_user_id: string;
          p_source_message_id: string;
          p_request_key: string;
          p_action_title: string;
          p_action_summary: string;
          p_approval_reason: string;
          p_capability_id: string;
          p_connector_id: string;
          p_operation_key: string;
          p_operation_version: number;
          p_connection_id: string | null;
          p_action_snapshot: Json;
        };
        Returns: Database["public"]["Tables"]["action_executions"]["Row"][];
      };
      decide_action_execution: {
        Args: {
          p_approval_id: string;
          p_actor_user_id: string;
          p_decision: "approved" | "rejected" | "cancelled";
          p_rejection_reason?: string | null;
        };
        Returns: Database["public"]["Tables"]["action_executions"]["Row"][];
      };
      claim_action_execution: {
        Args: { p_execution_id: string; p_actor_user_id: string };
        Returns: Database["public"]["Tables"]["action_executions"]["Row"][];
      };
      complete_action_execution: {
        Args: {
          p_execution_id: string;
          p_claim_token: string;
          p_status: "succeeded" | "failed" | "ambiguous";
          p_acknowledged: boolean;
          p_externally_delivered: boolean;
          p_provider_reference_id: string | null;
          p_result_summary: string | null;
          p_failure_category: string | null;
          p_failure_message: string | null;
        };
        Returns: Database["public"]["Tables"]["action_executions"]["Row"][];
      };
      ensure_default_workspace: {
        Args: { p_user_id: string };
        Returns: Array<{
          workspace_id: string;
          membership_role: "owner" | "admin" | "member";
        }>;
      };
      switch_active_workspace: {
        Args: { p_actor_user_id: string; p_workspace_id: string };
        Returns: Array<{ workspace_id: string; membership_role: "owner" | "admin" | "member" }>;
      };
      rename_company_workspace: {
        Args: { p_workspace_id: string; p_actor_user_id: string; p_name: string };
        Returns: Array<{ workspace_id: string; workspace_name: string }>;
      };
      create_workspace_invitation: {
        Args: { p_workspace_id: string; p_actor_user_id: string; p_invited_email: string; p_intended_role: "admin" | "member"; p_token_hash: string; p_expires_at: string };
        Returns: Database["public"]["Tables"]["workspace_invitations"]["Row"][];
      };
      revoke_workspace_invitation: {
        Args: { p_invitation_id: string; p_actor_user_id: string };
        Returns: Database["public"]["Tables"]["workspace_invitations"]["Row"][];
      };
      accept_workspace_invitation: {
        Args: { p_token_hash: string; p_actor_user_id: string; p_actor_email: string };
        Returns: Array<{ workspace_id: string; membership_role: "owner" | "admin" | "member"; acceptance_outcome: "accepted" | "already_accepted" | "expired" }>;
      };
      administer_workspace_member: {
        Args: { p_workspace_id: string; p_actor_user_id: string; p_target_user_id: string; p_action: "change_role" | "remove"; p_role?: "admin" | "member" | null };
        Returns: Array<{ workspace_id: string; user_id: string; membership_role: "owner" | "admin" | "member"; outcome: "role_changed" | "removed" }>;
      };
      get_public_workflow: {
        Args: { p_workflow_id: string };
        Returns: Array<{
          id: string;
          name: string;
          workflow_name: string;
          summary: string;
          public_form: Json | null;
          challenge_mode: "honeypot" | "turnstile";
        }>;
      };
      is_public_workflow: {
        Args: { p_workflow_id: string };
        Returns: boolean;
      };
      consume_security_rate_limit: {
        Args: {
          p_key_hash: string;
          p_limit: number;
          p_window_seconds: number;
        };
        Returns: Array<{
          allowed: boolean;
          remaining: number;
          reset_at: string;
        }>;
      };
      create_workflow_with_quota: {
        Args: {
          p_user_id: string;
          p_name: string;
          p_prompt: string;
          p_compiled_steps: Json;
          p_limit: number;
        };
        Returns: string | null;
      };
      create_versioned_workflow_with_quota: {
        Args: {
          p_user_id: string;
          p_name: string;
          p_prompt: string;
          p_compiled_workflow: Json;
          p_setup_config: Json;
          p_limit: number;
        };
        Returns: Array<{ workflow_id: string; version_id: string }>;
      };
      create_workflow_version: {
        Args: {
          p_workflow_id: string;
          p_user_id: string;
          p_expected_version_id: string;
          p_compiled_workflow: Json;
          p_setup_config: Json;
          p_change_scope: string;
          p_change_summary: string;
          p_source_version_id?: string | null;
        };
        Returns: Array<{ version_id: string; version_number: number }>;
      };
      publish_workflow_version: {
        Args: {
          p_workflow_id: string;
          p_user_id: string;
          p_expected_current_version_id: string;
          p_publish: boolean;
          p_challenge_mode: string;
          p_subscriptions?: Json;
          p_schedule?: Json | null;
        };
        Returns: Array<{
          published: boolean;
          published_version_id: string | null;
        }>;
      };
      create_execution_once: {
        Args: {
          p_workflow_id: string;
          p_workflow_version_id: string;
          p_user_id: string;
          p_trigger_type: string;
          p_trigger_metadata: Json;
          p_idempotency_key: string;
          p_input_data: Json;
        };
        Returns: Array<{ execution_id: string; created: boolean; execution_status: string }>;
      };
      claim_execution_retry: {
        Args: { p_execution_id: string; p_user_id: string };
        Returns: boolean;
      };
      claim_schedule_occurrence: {
        Args: { p_schedule_id: string; p_expected_next_run_at: string; p_scheduled_for: string; p_next_run_at: string | null; p_missed_earlier_count: number; p_should_execute: boolean };
        Returns: Array<{ occurrence_id: string | null; claimed: boolean; user_id: string; workflow_id: string; workflow_version_id: string; schedule_definition: Json; timezone: string }>;
      };
      record_connector_capability_request: {
        Args: { p_requester_hash: string; p_user_id: string | null; p_requested_provider: string; p_requested_capability: string | null; p_source: string };
        Returns: undefined;
      };
      configure_schedule_dispatch: {
        Args: { p_secret: string };
        Returns: undefined;
      };
      configure_gmail_work_sync: { Args: Record<PropertyKey, never>; Returns: undefined };
      fail_stale_executions: {
        Args: { p_older_than: string };
        Returns: number;
      };
      consume_usage_quota: {
        Args: {
          p_user_id: string;
          p_metric: string;
          p_amount: number;
          p_limit: number;
          p_period_started_at: string;
        };
        Returns: Array<{
          allowed: boolean;
          used: number;
          remaining: number;
        }>;
      };
      acquire_security_concurrency: {
        Args: {
          p_key_hash: string;
          p_lease_id: string;
          p_limit: number;
          p_ttl_seconds: number;
        };
        Returns: boolean;
      };
      release_security_concurrency: {
        Args: { p_key_hash: string; p_lease_id: string };
        Returns: undefined;
      };
      request_account_deletion: {
        Args: { p_user_id: string };
        Returns: string;
      };
      cleanup_account_data: {
        Args: { p_job_id: string; p_user_id: string };
        Returns: boolean;
      };
      cleanup_connector_account_data: {
        Args: { p_user_id: string };
        Returns: boolean;
      };
      claim_connector_token_refresh: {
        Args: { p_connection_id: string; p_user_id: string; p_lease_seconds?: number };
        Returns: boolean;
      };
      release_connector_token_refresh: {
        Args: { p_connection_id: string; p_user_id: string };
        Returns: boolean;
      };
      finalize_google_oauth_connection: {
        Args: {
          p_connection_id: string;
          p_user_id: string;
          p_external_account_id: string;
          p_external_account_label: string | null;
          p_granted_scopes: string[];
          p_token_expires_at: string | null;
          p_safe_metadata: Json;
          p_access_credential: Json;
          p_refresh_credential: Json | null;
        };
        Returns: string;
      };
      finalize_google_token_refresh: {
        Args: {
          p_connection_id: string;
          p_user_id: string;
          p_token_expires_at: string;
          p_access_credential: Json;
          p_refresh_credential: Json | null;
        };
        Returns: boolean;
      };
      enqueue_gmail_push_notification: {
        Args: { p_email_address: string; p_history_id: string; p_pubsub_subscription: string; p_pubsub_message_id: string; p_publish_time?: string | null };
        Returns: Array<{ receipt_id: string; connection_id: string; inserted: boolean; processed_history_id: string; observed_history_id: string }>;
      };
      claim_gmail_ingestion: {
        Args: { p_lease_seconds?: number };
        Returns: Array<{ connection_id: string; user_id: string; processed_history_id: string; observed_history_id: string; lease_token: string }>;
      };
      claim_gmail_work_poll: {
        Args: { p_lease_seconds?: number };
        Returns: Array<{ connection_id: string; user_id: string; lease_token: string }>;
      };
      list_uninitialized_gmail_work_connections: {
        Args: { p_limit?: number };
        Returns: Array<{ connection_id: string; user_id: string }>;
      };
      complete_gmail_work_poll: {
        Args: { p_connection_id: string; p_user_id: string; p_lease_token: string; p_history_id: string };
        Returns: boolean;
      };
      defer_gmail_work_poll: {
        Args: { p_connection_id: string; p_user_id: string; p_lease_token: string; p_error_category: string };
        Returns: boolean;
      };
      complete_gmail_ingestion: {
        Args: { p_connection_id: string; p_user_id: string; p_lease_token: string; p_expected_processed_history_id: string; p_completed_history_id: string };
        Returns: boolean;
      };
      defer_gmail_ingestion: {
        Args: { p_connection_id: string; p_user_id: string; p_lease_token: string; p_error_category: string };
        Returns: boolean;
      };
      run_operational_maintenance: {
        Args: {
          p_stale_before: string;
          p_rate_limit_retention_before: string;
          p_deletion_job_stale_before: string;
        };
        Returns: Json;
      };
      run_connector_maintenance: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
    };
  };
};
