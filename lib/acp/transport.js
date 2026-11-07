import { Readable, Writable } from 'node:stream';
import { client, methods, ndJsonStream, } from '@agentclientprotocol/sdk';
import { createStdoutJsonFilter } from '../acp-runner.js';
/** The same SDK framing/correlation/validation with stdout noise filter for Android/PRoot. */
export function connectTransport(input, output, onUpdate, onPermission) {
    const filteredInput = input.pipe(createStdoutJsonFilter());
    const app = client({ name: 'dsh-antigravity-acp' })
        .onNotification(methods.client.session.update, ({ params }) => {
        onUpdate(params);
    })
        .onRequest(methods.client.session.requestPermission, ({ params }) => {
        return onPermission(params) ?? { outcome: { outcome: 'cancelled' } };
    });
    return app.connect(ndJsonStream(Writable.toWeb(output), Readable.toWeb(filteredInput)));
}
