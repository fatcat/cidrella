import { ref } from 'vue';

// Keeps a dialog with unsaved edits from closing silently (W-05). Wire
// `requestClose` to the dialog's update:visible and to its Cancel button. The
// first dismissal of a dirty form shows the prompt instead of closing; the
// prompt's Discard, or a second dismissal (a second Escape), closes for real.
// A busy dialog never closes from here; the caller's own submit path does.
export function useDiscardGuard({ isDirty, close, busy = null }) {
  const confirmingDiscard = ref(false);

  function requestClose(visible = false) {
    if (visible !== false) return;
    if (busy?.value) return;
    if (isDirty() && !confirmingDiscard.value) {
      confirmingDiscard.value = true;
      return;
    }
    confirmingDiscard.value = false;
    close();
  }

  function keepEditing() {
    confirmingDiscard.value = false;
  }

  function discard() {
    confirmingDiscard.value = false;
    close();
  }

  function reset() {
    confirmingDiscard.value = false;
  }

  return { confirmingDiscard, requestClose, keepEditing, discard, reset };
}
