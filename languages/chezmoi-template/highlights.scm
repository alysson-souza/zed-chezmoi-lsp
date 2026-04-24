; Identifiers

[
  (field)
  (field_identifier)
] @property

(variable) @variable
(dot) @variable.special

; Function calls

(function_call
  function: (identifier) @function)

(method_call
  method: (selector_expression
    field: (field_identifier) @function))

; Common Go template and chezmoi functions

((identifier) @function.builtin
 (#match? @function.builtin "^(and|call|html|index|slice|js|len|not|or|print|printf|println|urlquery|eq|ne|lt|le|gt|ge|default|empty|coalesce|ternary|quote|squote|cat|indent|nindent|replace|trim|trimAll|trimPrefix|trimSuffix|lower|upper|title|hasPrefix|hasSuffix|contains|regexMatch|regexReplaceAll|list|dict|keys|values|toJson|fromJson|toYaml|fromYaml|includeTemplate|joinPath|lookPath|output|promptString|promptBool)$"))

; Operators

[
  "|"
  ":="
  "="
] @operator

; Delimiters and punctuation

[
  "."
  ","
] @punctuation.delimiter

[
  "{{"
  "}}"
  "{{-"
  "-}}"
  "("
  ")"
] @punctuation.bracket

; Keywords

[
  "block"
  "break"
  "continue"
  "define"
  "else"
  "end"
  "if"
  "range"
  "template"
  "with"
] @keyword

; Literals

[
  (interpreted_string_literal)
  (raw_string_literal)
  (rune_literal)
] @string

(escape_sequence) @string.escape

[
  (int_literal)
  (float_literal)
  (imaginary_literal)
] @number

[
  (true)
  (false)
  (nil)
] @constant.builtin

(comment) @comment
(ERROR) @error
