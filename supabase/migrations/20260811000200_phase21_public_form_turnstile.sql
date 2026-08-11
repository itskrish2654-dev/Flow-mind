begin;

-- Existing published forms that can consume AI/PDF quota must receive the same
-- challenge selected for newly published workflows. No workflow is deleted.
update public.workflows
set public_form_challenge_mode = case
  when exists (
    select 1
    from jsonb_array_elements(
      case
        when jsonb_typeof(compiled_steps -> 'steps') = 'array'
          then compiled_steps -> 'steps'
        else '[]'::jsonb
      end
    ) as step
    where step ->> 'capabilityId' in ('ai_text_transform', 'generate_pdf')
       or step ->> 'type' in ('ai_transform', 'generate_pdf')
  ) then 'turnstile'
  else 'honeypot'
end
where public_form_enabled = true;

commit;
