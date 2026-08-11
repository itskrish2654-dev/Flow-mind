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
        };
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
      workflow_executions: {
        Row: {
          id: string;
          workflow_id: string;
          input_data: Json;
          output_data: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          workflow_id: string;
          input_data?: Json;
          output_data?: Json;
          created_at?: string;
        };
        Update: {
          id?: string;
          workflow_id?: string;
          input_data?: Json;
          output_data?: Json;
          created_at?: string;
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
    };
  };
};
