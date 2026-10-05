import { useState, type FormEvent } from 'react';

// Shared by the home page (Add Row) and the row canvas (Add Stem).
// CropLink defined an identical copy in each page.
export function TextPromptModal({
  title,
  label,
  defaultValue,
  onClose,
  onSave,
}: {
  title: string;
  label: string;
  defaultValue?: string;
  onClose: () => void;
  onSave: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState(defaultValue ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!value.trim()) { setError(`${label} is required`); return; }
    setSaving(true);
    try {
      await onSave(value.trim());
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
        <div className="modal-title">{title}</div>
        {error && <div className="alert alert-error">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">{label}</label>
            <input className="form-control" value={value} onChange={e => setValue(e.target.value)} autoFocus />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
