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
        };
        Insert: {
          id?: string;
          user_id: string;
          name: string;
          prompt: string;
          compiled_steps?: Json | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          name?: string;
          prompt?: string;
          compiled_steps?: Json | null;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
};
