-- Repair JSON values written before the column type stopped double-encoding.
--
-- Drizzle's built-in `jsonb()` stringifies in `mapToDriverValue`, and Bun SQL
-- treats a string bound to a JSONB parameter as a JSON *string*. Every object
-- and array therefore landed quoted: `"{}"` instead of `{}`. That made
-- `span.tags` invisible to its GIN index and `jsonb_array_length(code_frames)`
-- fail with "cannot get array length of a scalar".
--
-- `src/server/db/schema.ts` now uses a custom column whose driver value is the
-- value itself, so new writes are correct. This converts the rows already
-- there. `#>> '{}'` unwraps the outer string; the first character check keeps a
-- legitimate bare-string value from being parsed as JSON.
UPDATE project
   SET settings = (settings #>> '{}')::jsonb
 WHERE jsonb_typeof(settings) = 'string'
   AND left(settings #>> '{}', 1) IN ('{', '[');

UPDATE execution
   SET error = (error #>> '{}')::jsonb
 WHERE jsonb_typeof(error) = 'string'
   AND left(error #>> '{}', 1) IN ('{', '[');

UPDATE execution
   SET tags = (tags #>> '{}')::jsonb
 WHERE jsonb_typeof(tags) = 'string'
   AND left(tags #>> '{}', 1) IN ('{', '[');

UPDATE execution
   SET request = (request #>> '{}')::jsonb
 WHERE jsonb_typeof(request) = 'string'
   AND left(request #>> '{}', 1) IN ('{', '[');

UPDATE span
   SET tags = (tags #>> '{}')::jsonb
 WHERE jsonb_typeof(tags) = 'string'
   AND left(tags #>> '{}', 1) IN ('{', '[');

UPDATE error_occurrence
   SET code_frames = (code_frames #>> '{}')::jsonb
 WHERE jsonb_typeof(code_frames) = 'string'
   AND left(code_frames #>> '{}', 1) IN ('{', '[');

UPDATE log_entry
   SET attributes = (attributes #>> '{}')::jsonb
 WHERE jsonb_typeof(attributes) = 'string'
   AND left(attributes #>> '{}', 1) IN ('{', '[');

UPDATE runtime_sample
   SET cpu = (cpu #>> '{}')::jsonb
 WHERE jsonb_typeof(cpu) = 'string'
   AND left(cpu #>> '{}', 1) IN ('{', '[');

UPDATE runtime_sample
   SET memory = (memory #>> '{}')::jsonb
 WHERE jsonb_typeof(memory) = 'string'
   AND left(memory #>> '{}', 1) IN ('{', '[');

UPDATE runtime_sample
   SET gc = (gc #>> '{}')::jsonb
 WHERE jsonb_typeof(gc) = 'string'
   AND left(gc #>> '{}', 1) IN ('{', '[');

UPDATE runtime_sample
   SET event_loop = (event_loop #>> '{}')::jsonb
 WHERE jsonb_typeof(event_loop) = 'string'
   AND left(event_loop #>> '{}', 1) IN ('{', '[');

UPDATE metric_series
   SET labels = (labels #>> '{}')::jsonb
 WHERE jsonb_typeof(labels) = 'string'
   AND left(labels #>> '{}', 1) IN ('{', '[');

UPDATE alert_rule
   SET channels = (channels #>> '{}')::jsonb
 WHERE jsonb_typeof(channels) = 'string'
   AND left(channels #>> '{}', 1) IN ('{', '[');

UPDATE alert_event
   SET payload = (payload #>> '{}')::jsonb
 WHERE jsonb_typeof(payload) = 'string'
   AND left(payload #>> '{}', 1) IN ('{', '[');

UPDATE instance_setting
   SET value = (value #>> '{}')::jsonb
 WHERE jsonb_typeof(value) = 'string'
   AND left(value #>> '{}', 1) IN ('{', '[');

UPDATE audit_log
   SET detail = (detail #>> '{}')::jsonb
 WHERE jsonb_typeof(detail) = 'string'
   AND left(detail #>> '{}', 1) IN ('{', '[');
