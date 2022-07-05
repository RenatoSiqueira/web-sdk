#!/usr/bin/env bash

step_header() {
  cecho -n --bright-green "•" --bright-cyan "${1}:" --yellow "${2}" --orange "${3:-}"
}

step() {
  description=$1
  command=$2

  step_header "${description}" "${command}"
  eval "${command}" 
  # output=$(eval "${command}" 2>&1)

  if [ $? -eq 0 ]; then
    cecho --bold-bright-green "OK"
  else
    echo "FAILED"

    cecho --red "FAILED"
    # cecho --red $output
    exit
  fi
}

step_with_output() {
  description=$1
  command=$2

  echo ""
  step_header "${description}" "${command}"
  echo ""
  eval "${command}"

  if [ $? -ne 0 ]; then
    cecho --red "FAILED"
    exit 1
  fi
  echo ""
}

section() {
  title=$1
  cecho --yellow "\n${title}"
}

xstep() {
  description=$1
  command=$2

  step_header "${description}" "${command}" "[SKIPPED]"

  return 0
}
