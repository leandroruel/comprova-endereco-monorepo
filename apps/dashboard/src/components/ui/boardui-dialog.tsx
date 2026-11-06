"use client";

import {
  Modal as BoardUIModal,
  ModalTrigger as BoardUIModalTrigger,
  ModalHeader,
  ModalBody,
  ModalFooter,
  AlertDialog,
  type ModalProps,
  type ModalSize,
  type AlertDialogProps,
} from "@/components/base/modal/modal";

/**
 * Board UI Modal / Dialog re-exported from the shared UI barrel.
 *
 * Built on React Aria's Dialog / ModalOverlay: focus is trapped inside,
 * Escape and backdrop click dismiss, and focus returns to the trigger on
 * close. Both the admin and verifier dashboards can use these from
 * `@/components/ui`.
 */
export {
  BoardUIModal as Modal,
  BoardUIModalTrigger as ModalTrigger,
  ModalHeader,
  ModalBody,
  ModalFooter,
  AlertDialog,
};
export type { ModalProps, ModalSize, AlertDialogProps };
