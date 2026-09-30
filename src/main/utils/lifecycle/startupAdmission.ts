let admissionOpen = true;

export function isStartupAdmissionOpen(): boolean {
  return admissionOpen;
}

export function closeStartupAdmission(): void {
  admissionOpen = false;
}
