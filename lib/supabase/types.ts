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
        };
        Insert: {
          id?: string;
          user_id: string;
          name: string;
          prompt: string;
          compiled_steps?: Json | null;
          public_form_enabled?: boolean;
        };
        Update: {
          id?: string;
          user_id?: string;
          name?: string;
          prompt?: string;
          compiled_steps?: Json | null;
          public_form_enabled?: boolean;
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
        }>;
      };
      is_public_workflow: {
        Args: { p_workflow_id: string };
        Returns: boolean;
      };
    };
  };
};
