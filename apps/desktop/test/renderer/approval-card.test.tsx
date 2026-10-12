// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ApprovalCard } from '../../src/renderer/src/components/ApprovalCard';

afterEach(cleanup);

describe('approval card', () => {
  it('offers no conversation-wide allow for a send read from the model\'s text', () => {
    render(<ApprovalCard approval={{ kind: 'send', requestId: 'a.req.yml', host: 'api.local', textParsed: true }} onAnswer={() => {}} />);
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Allow for this conversation' })).toBeNull();
  });

  it('keeps the conversation-wide allow for a native send', () => {
    render(<ApprovalCard approval={{ kind: 'send', requestId: 'a.req.yml', host: 'api.local' }} onAnswer={() => {}} />);
    expect(screen.getByRole('button', { name: 'Allow for this conversation' })).toBeTruthy();
  });

  it('lists the files a send uploads, with sizes, and offers no conversation-wide allow', () => {
    render(<ApprovalCard approval={{ kind: 'send', requestId: 'a.req.yml', host: 'api.local', files: [{ name: 'doc', fileName: 'report.pdf', size: 2048 }, { name: '', fileName: 'raw.bin' }] }} onAnswer={() => {}} />);
    expect(screen.getByText('Uploads 2 files:')).toBeTruthy();
    expect(screen.getByText('report.pdf (2.0 KB) as doc')).toBeTruthy();
    expect(screen.getByText('raw.bin (size unknown) as the body')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Allow for this conversation' })).toBeNull();
    cleanup();
    render(<ApprovalCard approval={{ kind: 'new-host', requestId: 'a.req.yml', host: 'evil.example', files: [{ name: 'doc', fileName: 'report.pdf', size: 12 }] }} onAnswer={() => {}} />);
    expect(screen.getByText('Uploads 1 file:')).toBeTruthy();
    expect(screen.getByText('report.pdf (12 B) as doc')).toBeTruthy();
  });

  it('shows where each file is (for the user only), and a file that needs choosing without a size', () => {
    render(<ApprovalCard approval={{ kind: 'send', requestId: 'a.req.yml', host: 'api.local', files: [
      { name: 'doc', fileName: 'config', status: 'needsChoosing', location: 'in this collection: .git/config' },
      { name: 'img', fileName: 'logo.png', size: 12, location: 'in this collection: files/logo.png' },
    ] }} onAnswer={() => {}} />);
    expect(screen.getByText('config (needs choosing) as doc')).toBeTruthy();
    expect(screen.getByText('in this collection: .git/config')).toBeTruthy();
    expect(screen.getByText('logo.png (12 B) as img')).toBeTruthy();
    expect(screen.getByText('in this collection: files/logo.png')).toBeTruthy();
  });
});
