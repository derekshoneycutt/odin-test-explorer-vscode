package main

import "core:encoding/json"
import "core:fmt"
import "core:os"

// run validates CLI input, discovers one package, and writes its JSON response.
// It returns a process exit code so main can release temporary storage first.
run :: proc() -> int {
	if len(os.args) != 2 {
		fmt.eprintln("usage: odin-test-discovery <package-directory>")
		return 2
	}

	response, ok := discover_package(os.args[1])
	if !ok {
		fmt.eprintln("failed to parse Odin package")
		return 1
	}

	data, marshal_error := json.marshal(response)
	if marshal_error != nil {
		fmt.eprintln("failed to encode discovery response")
		return 1
	}
	fmt.println(string(data))
	return 0
}

// main owns the one-shot helper lifetime and releases all temporary allocations
// before forwarding a non-zero exit code to the operating system.
main :: proc() {
	exit_code := run()
	free_all(context.temp_allocator)
	if exit_code != 0 {
		os.exit(exit_code)
	}
}