-- Settings hold scalars, and the pre-custom-type jsonb column double-encoded
-- strings as well: `"\"Test\""` instead of `"Test"`. 0001 only unwrapped
-- object/array payloads, because a bare string is ambiguous there. For
-- `instance_setting.value` the ambiguity is resolvable: only a value whose
-- unwrapped form starts with a quote is a second layer of JSON encoding.
UPDATE instance_setting
   SET value = (value #>> '{}')::jsonb
 WHERE jsonb_typeof(value) = 'string'
   AND left(value #>> '{}', 1) = '"';
