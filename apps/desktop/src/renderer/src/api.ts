import type { ApiJanusBridge, Channel, ChannelMap, DropImportPayload, UploadChoice, HistoryAddedEnvelope, WorkspaceEventEnvelope, JanusEventEnvelope, RequestRanEnvelope, RunnerEventEnvelope, UpdateState } from '../../shared/api';

export class ApiError extends Error {}

export interface Api {
  /** process.platform of the app, for shortcut labels and wording ('' if the bridge does not say). */
  platform: string;
  call<C extends Channel>(channel: C, payload: ChannelMap[C]['payload']): Promise<ChannelMap[C]['result']>;
  onWorkspaceEvent(listener: (e: WorkspaceEventEnvelope) => void): () => void;
  onJanusEvent(listener: (e: JanusEventEnvelope) => void): () => void;
  onRequestRan(listener: (e: RequestRanEnvelope) => void): () => void;
  onRunEvent(listener: (e: RunnerEventEnvelope) => void): () => void;
  onHistoryAdded(listener: (e: HistoryAddedEnvelope) => void): () => void;
  onUpdateState(listener: (s: UpdateState) => void): () => void;
  /** Previews a file dropped onto the import dialog (see ApiJanusBridge.dropImport). */
  dropImport(file: File, payload: DropImportPayload): Promise<ChannelMap['import:drop']['result']>;
  /** Chooses a file dropped onto a File row to upload (see ApiJanusBridge.dropUpload). */
  dropUpload(file: File): Promise<UploadChoice>;
}

export function createApi(bridge: ApiJanusBridge): Api {
  return {
    platform: typeof bridge.platform === 'string' ? bridge.platform : '',
    async call<C extends Channel>(channel: C, payload: ChannelMap[C]['payload']) {
      const result = await bridge.invoke(channel, payload);
      if (!result.ok) throw new ApiError(result.error);
      return result.value as ChannelMap[C]['result'];
    },
    async dropImport(file, payload) {
      const result = await bridge.dropImport(file, payload);
      if (!result.ok) throw new ApiError(result.error);
      return result.value as ChannelMap['import:drop']['result'];
    },
    async dropUpload(file) {
      const result = await bridge.dropUpload(file);
      if (!result.ok) throw new ApiError(result.error);
      return result.value as UploadChoice;
    },
    onWorkspaceEvent(listener) {
      return bridge.on('workspace:event', (payload) => {
        if (!payload || typeof payload !== 'object') return;
        const p = payload as Partial<WorkspaceEventEnvelope>;
        if (typeof p.root !== 'string' || !p.event || typeof p.event !== 'object') return;
        listener(p as WorkspaceEventEnvelope);
      });
    },
    onJanusEvent(listener) {
      return bridge.on('janus:event', (payload) => {
        if (!payload || typeof payload !== 'object') return;
        const p = payload as Partial<JanusEventEnvelope>;
        if (typeof p.root !== 'string' || typeof p.conversationId !== 'string' || typeof p.turnId !== 'string') return;
        if (!p.event || typeof p.event !== 'object') return;
        listener(p as JanusEventEnvelope);
      });
    },
    onRequestRan(listener) {
      return bridge.on('request:ran', (payload) => {
        if (!payload || typeof payload !== 'object') return;
        const p = payload as Partial<RequestRanEnvelope>;
        if (typeof p.root !== 'string' || typeof p.id !== 'string' || !p.run || typeof p.run !== 'object') return;
        listener(p as RequestRanEnvelope);
      });
    },
    onHistoryAdded(listener) {
      return bridge.on('history:added', (payload) => {
        if (!payload || typeof payload !== 'object') return;
        const p = payload as Partial<HistoryAddedEnvelope>;
        if (typeof p.root !== 'string' || !p.entry || typeof p.entry !== 'object') return;
        listener(p as HistoryAddedEnvelope);
      });
    },
    onUpdateState(listener) {
      return bridge.on('update:state', (payload) => {
        if (!payload || typeof payload !== 'object') return;
        const p = payload as Partial<UpdateState>;
        if (typeof p.kind !== 'string' || typeof p.current !== 'string' || typeof p.build !== 'string' || typeof p.installs !== 'boolean' || typeof p.auto !== 'boolean') return;
        listener(p as UpdateState);
      });
    },
    onRunEvent(listener) {
      return bridge.on('run:event', (payload) => {
        if (!payload || typeof payload !== 'object') return;
        const p = payload as Partial<RunnerEventEnvelope>;
        if (typeof p.root !== 'string' || typeof p.runId !== 'string' || !p.event || typeof p.event !== 'object') return;
        if (typeof (p.event as { type?: unknown }).type !== 'string') return;
        listener(p as RunnerEventEnvelope);
      });
    },
  };
}
