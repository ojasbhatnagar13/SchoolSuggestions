// Generated from backend/.env
//
// These two values are PUBLIC BY DESIGN. The anon key is meant to be shipped
// to browsers -- RLS and the security definer functions are what protect the
// data, not key secrecy. Never put a service_role key in this file.

export const SUPABASE_URL = "https://ywyjhgpcokrtzibcrqes.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3eWpoZ3Bjb2tydHppYmNycWVzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ2OTQ1MDcsImV4cCI6MjEwMDI3MDUwN30.fyKWPSG31gbxviEIp45FozViqov7VL9elZBqKzFA-YA";
export const MODERATE_URL = `${SUPABASE_URL}/functions/v1/moderate-suggestion`;
