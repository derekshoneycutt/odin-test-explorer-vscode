package main

import "core:odin/ast"
import odin_parser "core:odin/parser"

// Identifies the JSON contract shared by the helper and extension.
PROTOCOL_VERSION :: 1

// Source_Position identifies a one-based location in an Odin source file.
Source_Position :: struct {
	// line is the one-based source line.
	line:   int,
	// column is the one-based byte column.
	column: int,
}

// Discovered_Test describes one test procedure found in a package AST.
Discovered_Test :: struct {
	// package_name is the name from the package declaration.
	package_name: string,
	// package_path is the absolute directory parsed by the helper.
	package_path: string,
	// name is the unqualified test procedure name.
	name:         string,
	// file_path is the absolute path to the declaring source file.
	file_path:    string,
	// start is the beginning of the procedure identifier.
	start:        Source_Position,
	// end is the end of the procedure identifier.
	end:          Source_Position,
}

// Discovery_Response is the versioned JSON payload written to stdout.
Discovery_Response :: struct {
	// version allows the extension to reject incompatible helper output.
	version: int,
	// tests contains every syntactically discovered test in the package.
	tests:   []Discovered_Test,
}

// attribute_is_test reports whether an attribute contains the `test` marker.
attribute_is_test :: proc(attribute: ^ast.Attribute) -> bool {
	for element in attribute.elems {
		if identifier, ok := element.derived.(^ast.Ident);
		   ok && identifier.name == "test" {
			return true
		}
	}

	return false
}

// declaration_is_test reports whether a value declaration has a test attribute.
declaration_is_test :: proc(declaration: ^ast.Value_Decl) -> bool {
	for attribute in declaration.attributes {
		if attribute_is_test(attribute) {
			return true
		}
	}

	return false
}

// discover_package parses one package directory and returns its test procedures.
// The returned response and parser AST borrow storage from the current context;
// the caller owns that allocator's lifetime.
discover_package :: proc(
	package_path: string) -> (Discovery_Response, bool) {

	// Package parsing includes every non-empty Odin file in the directory.
	parsed_package, ok := odin_parser.parse_package_from_path(package_path)
	if !ok {
		return {}, false
	}

	tests := make([dynamic]Discovered_Test, context.temp_allocator)
	for _, source_file in parsed_package.files {
		for statement in source_file.decls {
			// Test attributes are attached to top-level value declarations.
			declaration, is_value_declaration := statement.derived.(^ast.Value_Decl)
			if !is_value_declaration || !declaration_is_test(declaration) {
				continue
			}

			for value, index in declaration.values {
				// Names and values are aligned by index for valid declarations.
				if index >= len(declaration.names) {
					break
				}
				if _, is_procedure := value.derived.(^ast.Proc_Lit); !is_procedure {
					continue
				}

				identifier, is_identifier := declaration.names[index].derived.(^ast.Ident)
				if !is_identifier {
					continue
				}

				// Identifier positions make the Test Explorer item navigable.
				append(&tests, Discovered_Test {
					package_name = parsed_package.name,
					package_path = parsed_package.fullpath,
					name = identifier.name,
					file_path = source_file.fullpath,
					start = {line = identifier.pos.line, column = identifier.pos.column},
					end = {line = identifier.end.line, column = identifier.end.column},
				})
			}
		}
	}

	return Discovery_Response {
		version = PROTOCOL_VERSION,
		tests = tests[:],
	}, true
}