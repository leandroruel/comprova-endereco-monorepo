"use client";

import { Input as BoardUIInput, type InputProps } from "@/components/base/input/input";

/**
 * Board UI Input re-exported from the shared UI barrel.
 *
 * Built on React Aria Components: label ↔ input ↔ hint association is
 * automatic (aria-labelledby / aria-describedby), and `errorMessage` renders
 * a FieldError when the field is invalid.
 */
export { BoardUIInput as Input };
export type { InputProps };
