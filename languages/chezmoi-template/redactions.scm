(function_call
  function: (identifier) @_function
  arguments: (argument_list) @redact
  (#match? @_function "^(promptString|promptBool|output)$"))
