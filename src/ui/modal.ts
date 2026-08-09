export interface ModalOptions {
  modalEl: HTMLElement | null;
  openBtnEl: HTMLElement | null;
  closeBtnEl: HTMLElement | null;
}

/**
 * Initializes modal state, DOM selectors, backdrop clicks, and keyboard traps (Escape key).
 */
export function initModal({ modalEl, openBtnEl, closeBtnEl }: ModalOptions): () => void {
  const closeModal = () => {
    if (modalEl) {
      modalEl.classList.add('hidden');
      modalEl.setAttribute('aria-hidden', 'true');
    }
  };

  const openModal = () => {
    if (modalEl) {
      modalEl.classList.remove('hidden');
      modalEl.setAttribute('aria-hidden', 'false');
    }
  };

  if (openBtnEl) {
    openBtnEl.addEventListener('click', openModal);
  }

  if (closeBtnEl) {
    closeBtnEl.addEventListener('click', closeModal);
  }

  const handleBackdropClick = (e: MouseEvent) => {
    if (e.target === modalEl) {
      closeModal();
    }
  };

  if (modalEl) {
    modalEl.addEventListener('click', handleBackdropClick);
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && modalEl && !modalEl.classList.contains('hidden')) {
      closeModal();
    }
  };

  window.addEventListener('keydown', handleKeyDown);

  // Return cleanup function
  return () => {
    if (openBtnEl) openBtnEl.removeEventListener('click', openModal);
    if (closeBtnEl) closeBtnEl.removeEventListener('click', closeModal);
    if (modalEl) modalEl.removeEventListener('click', handleBackdropClick);
    window.removeEventListener('keydown', handleKeyDown);
  };
}
