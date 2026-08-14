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
      workflows: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          prompt: string;
          compiled_steps: Json | null;
          public_form_enabled: boolean;
          published_at: string | null;
          public_form_challenge_mode: "honeypot" | "turnstile";
          created_at: string;
          updated_at: string;
          current_version_id: string | null;
          lifecycle_state: "active" | "disabled" | "archived";
          archived_at: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          name: string;
          prompt: string;
          compiled_steps?: Json | null;
          public_form_enabled?: boolean;
          published_at?: string | null;
          public_form_challenge_mode?: "honeypot" | "turnstile";
          created_at?: string;
          updated_at?: string;
          current_version_id?: string | null;
          lifecycle_state?: "active" | "disabled" | "archived";
          archived_at?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          name?: string;
          prompt?: string;
          compiled_steps?: Json | null;
          public_form_enabled?: boolean;
          published_at?: string | null;
          public_form_challenge_mode?: "honeypot" | "turnstile";
          created_at?: string;
          updated_at?: string;
          current_version_id?: string | null;
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
        Row: { id: string; user_id: string; connector_id: string; provider_family: string; external_account_id: string; external_account_label: string | null; auth_type: "none" | "api_key" | "oauth2"; status: "connected" | "expired" | "revoked" | "error"; granted_scopes: string[]; token_expires_at: string | null; last_refreshed_at: string | null; last_error_category: string | null; safe_metadata: Json; created_at: string; updated_at: string };
        Insert: { id?: string; user_id: string; connector_id: string; provider_family: string; external_account_id: string; external_account_label?: string | null; auth_type: "none" | "api_key" | "oauth2"; status?: "connected" | "expired" | "revoked" | "error"; granted_scopes?: string[]; token_expires_at?: string | null; last_refreshed_at?: string | null; last_error_category?: string | null; safe_metadata?: Json; created_at?: string; updated_at?: string };
        Update: { external_account_label?: string | null; status?: "connected" | "expired" | "revoked" | "error"; granted_scopes?: string[]; token_expires_at?: string | null; last_refreshed_at?: string | null; last_error_category?: string | null; safe_metadata?: Json; updated_at?: string };
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
