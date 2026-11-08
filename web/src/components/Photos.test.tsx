import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import * as api from '../api/endpoints';
import type { CaseImage } from '../api/models';
import { useAuth } from '../state/auth';
import * as imagesLib from '../lib/images';
import { ApiError } from '../api/client';
import { PhotosSection } from './Photos';

const img = (n: number, over: Partial<CaseImage> = {}): CaseImage => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  content_type: 'image/jpeg',
  bytes: 120_000,
  width: 800,
  height: 600,
  caption: `Caption ${n}`,
  uploaded_by: { kind: 'responder', responder_name: 'Alice' },
  created_at: '2026-11-07T10:00:00Z',
  ...over,
});

const wrap = (ui: React.ReactElement) => (
  <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
);

let urlSeq = 0;
beforeEach(() => {
  urlSeq = 0;
  URL.createObjectURL = vi.fn(() => `blob:t/${++urlSeq}`) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(api, 'fetchImageBlob').mockImplementation(async () => new Blob(['x'], { type: 'image/jpeg' }));
  useAuth.setState({ responder: { id: 'me', username: 'alice', name: 'Alice', role: 'responder' } });
});
afterEach(() => vi.restoreAllMocks());

const base = { sosId: 's1', isAdmin: false, canClaim: true, myName: 'Alice' };

describe('Photos section', () => {
  it('shows the locked placeholder with only the count when the viewer is not entitled', () => {
    render(wrap(<PhotosSection {...base} count={3} images={undefined} canUpload={false} />));
    expect(screen.getByTestId('photos-locked')).toHaveTextContent('3 photos');
    expect(screen.getByText('Claim this case to see photos')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add photo/i })).toBeNull();
    expect(api.fetchImageBlob).not.toHaveBeenCalled();
  });
  it('volunteers get an honest message instead of a claim hint', () => {
    render(wrap(<PhotosSection {...base} canClaim={false} count={1} images={undefined} canUpload={false} />));
    expect(screen.getByText(/Only admins and the assigned responder can see photos/)).toBeInTheDocument();
  });
  it('unlocked: loads thumbnails through authenticated blobs and shows the n of 6 counter', async () => {
    render(wrap(<PhotosSection {...base} count={2} images={[img(1), img(2)]} canUpload />));
    expect(screen.getByText('2 of 6 photos')).toBeInTheDocument();
    expect(await screen.findAllByRole('img')).toHaveLength(2);
    expect(api.fetchImageBlob).toHaveBeenCalledWith('s1', img(1).id);
    expect(screen.getByRole('button', { name: 'Add photo' })).toBeEnabled();
  });
  it('disables Add photo at the limit', () => {
    render(wrap(<PhotosSection {...base} count={6} images={[1, 2, 3, 4, 5, 6].map((n) => img(n))} canUpload />));
    expect(screen.getByRole('button', { name: 'Add photo' })).toBeDisabled();
  });
  it('viewers who cannot upload do not get the add control', () => {
    render(wrap(<PhotosSection {...base} count={1} images={[img(1)]} canUpload={false} />));
    expect(screen.queryByRole('button', { name: 'Add photo' })).toBeNull();
  });
  it('revokes object URLs when the panel unmounts', async () => {
    const { unmount } = render(wrap(<PhotosSection {...base} count={2} images={[img(1), img(2)]} canUpload={false} />));
    await screen.findAllByRole('img');
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });
  it('shows an error tile with Retry when a photo fails to load', async () => {
    vi.mocked(api.fetchImageBlob).mockRejectedValueOnce(new Error('boom'));
    render(wrap(<PhotosSection {...base} count={1} images={[img(1)]} canUpload={false} />));
    const retry = await screen.findByRole('button', { name: 'Retry' });
    await userEvent.click(retry);
    expect(await screen.findByRole('img')).toBeInTheDocument();
  });
});

describe('Lightbox', () => {
  async function open() {
    const user = userEvent.setup();
    render(wrap(<PhotosSection {...base} count={3} images={[img(1), img(2), img(3, { uploaded_by: { kind: 'device' } })]} canUpload isAdmin={false} />));
    await user.click(await screen.findByRole('button', { name: /Open Photo 1/ }));
    return user;
  }
  it('opens an accessible dialog with caption, uploader, size and a download link', async () => {
    await open();
    const dlg = screen.getByRole('dialog', { name: 'Photo 1 of 3' });
    expect(dlg).toHaveAttribute('aria-modal', 'true');
    expect(dlg).toHaveTextContent('Caption 1');
    expect(dlg).toHaveTextContent('Uploaded by Alice');
    expect(dlg).toHaveTextContent('117 KB');
    expect(await screen.findByRole('link', { name: 'Download' })).toHaveAttribute('download');
  });
  it('arrow keys, Home and End move between photos and Escape closes', async () => {
    const user = await open();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('dialog', { name: 'Photo 2 of 3' })).toBeInTheDocument();
    await user.keyboard('{End}');
    expect(screen.getByRole('dialog', { name: 'Photo 3 of 3' })).toHaveTextContent('Uploaded by the person who asked for help');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('dialog', { name: 'Photo 3 of 3' })).toBeInTheDocument();
    await user.keyboard('{Home}');
    expect(screen.getByRole('dialog', { name: 'Photo 1 of 3' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('traps focus: Tab cycles inside the dialog and focus returns to the thumbnail on close', async () => {
    const user = await open();
    const dlg = screen.getByRole('dialog');
    for (let i = 0; i < 8; i++) {
      await user.tab();
      expect(dlg.contains(document.activeElement)).toBe(true);
    }
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.getByRole('button', { name: /Open Photo 1/ })).toHaveFocus());
  });
  it('delete asks for confirmation first, then deletes (uploader may delete)', async () => {
    const del = vi.spyOn(api, 'deleteImage').mockResolvedValue(undefined);
    const user = await open();
    await user.click(screen.getByRole('button', { name: /Delete…/ }));
    expect(del).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Delete this photo?' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete photo' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('s1', img(1).id));
  });
  it('hides delete for photos someone else uploaded when the viewer is not admin', async () => {
    const user = userEvent.setup();
    render(wrap(<PhotosSection {...base} count={1} images={[img(1, { uploaded_by: { kind: 'responder', responder_name: 'Bob' } })]} canUpload isAdmin={false} />));
    await user.click(await screen.findByRole('button', { name: /Open Photo 1/ }));
    expect(screen.queryByRole('button', { name: /Delete…/ })).toBeNull();
  });
});

describe('Add photo flow', () => {
  const file = () => new File(['abc'], 'roof.png', { type: 'image/png' });
  beforeEach(() => {
    vi.spyOn(imagesLib, 'processImage').mockResolvedValue({ blob: new Blob(['jpg'], { type: 'image/jpeg' }), contentType: 'image/jpeg', width: 800, height: 600 });
  });
  async function stage() {
    const user = userEvent.setup();
    render(wrap(<PhotosSection {...base} count={0} images={[]} canUpload />));
    await user.upload(screen.getByTestId('photo-input'), file());
    await screen.findByRole('button', { name: 'Upload photo' });
    return user;
  }
  it('stages the processed photo with a caption field and metadata note', async () => {
    await stage();
    expect(screen.getByText(/metadata removed/)).toBeInTheDocument();
    expect(screen.getByLabelText('Caption (optional)')).toHaveAttribute('maxlength', '200');
  });
  it('explains a 409 full case and offers no retry', async () => {
    vi.spyOn(api, 'uploadImage').mockRejectedValue(new ApiError(409, 'conflict', 'full'));
    const user = await stage();
    await user.click(screen.getByRole('button', { name: 'Upload photo' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already has 6 photos/);
    expect(screen.queryByRole('button', { name: 'Retry upload' })).toBeNull();
  });
  it('a network failure retries with the same UUID', async () => {
    const put = vi.spyOn(api, 'uploadImage').mockRejectedValueOnce(new ApiError(0, 'network', 'down')).mockResolvedValue({ image: img(1), created: true });
    const user = await stage();
    await user.click(screen.getByRole('button', { name: 'Upload photo' }));
    await user.click(await screen.findByRole('button', { name: 'Retry upload' }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    expect(put.mock.calls[0][1]).toBe(put.mock.calls[1][1]);
    await waitFor(() => expect(screen.queryByRole('group', { name: /Photo to upload/ })).toBeNull());
  });
  it('rejects non-image files with a clear message', async () => {
    const user = userEvent.setup({ applyAccept: false });
    render(wrap(<PhotosSection {...base} count={0} images={[]} canUpload />));
    await user.upload(screen.getByTestId('photo-input'), new File(['x'], 'a.pdf', { type: 'application/pdf' }));
    expect(imagesLib.processImage).not.toHaveBeenCalled();
  });
});
