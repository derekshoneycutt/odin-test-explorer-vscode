package main

import "core:testing"

// discover_package_finds_this_test verifies that discovery can find its own
// attributed procedure and preserve package, file, and source-position data.
@(test)
discover_package_finds_this_test :: proc(testing_context: ^testing.T) {
	// Discovery results use temporary storage in tests, so release it on return.
	defer free_all(context.temp_allocator)

	response, ok := discover_package(#directory)
	testing.expect(testing_context, ok)

	found := false
	for discovered_test in response.tests {
		if discovered_test.name == "discover_package_finds_this_test" {
			found = true
			testing.expect_value(testing_context, discovered_test.package_name, "main")
			testing.expect_value(testing_context, discovered_test.file_path, #file)
			testing.expect(testing_context, discovered_test.start.line > 0)
			testing.expect(testing_context, discovered_test.start.column > 0)
		}
	}

	testing.expect(testing_context, found)
}