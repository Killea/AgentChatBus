import * as fs from 'fs';
import * as path from 'path';

export type WorkspaceDevContext = {
    repoRoot: string;
    tsServerRoot: string;
    tsxCliEntrypoint: string;
    webUiRoot: string;
    webUiExtensionRoot: string;
    vscodeExtensionRoot: string;
};

type ExistsSync = (input: string) => boolean;

function isWorkspaceDevRepoRoot(repoRoot: string, existsSync: ExistsSync): boolean {
    const requiredPaths = [
        path.join(repoRoot, 'agentchatbus-ts', 'package.json'),
        path.join(repoRoot, 'agentchatbus-ts', 'src', 'cli', 'index.ts'),
        path.join(repoRoot, 'agentchatbus-ts', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        path.join(repoRoot, 'web-ui', 'index.html'),
        path.join(repoRoot, 'web-ui', 'extension', 'index.html'),
        path.join(repoRoot, 'vscode-agentchatbus', 'package.json'),
    ];

    return requiredPaths.every((candidate) => existsSync(candidate));
}

export function resolveWorkspaceDevContext(
    candidateRoots: readonly string[],
    existsSync: ExistsSync = fs.existsSync
): WorkspaceDevContext | null {
    for (const candidateRoot of candidateRoots) {
        const repoRoot = path.resolve(String(candidateRoot || '').trim());
        if (!repoRoot) {
            continue;
        }

        if (!isWorkspaceDevRepoRoot(repoRoot, existsSync)) {
            continue;
        }

        return {
            repoRoot,
            tsServerRoot: path.join(repoRoot, 'agentchatbus-ts'),
            tsxCliEntrypoint: path.join(repoRoot, 'agentchatbus-ts', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
            webUiRoot: path.join(repoRoot, 'web-ui'),
            webUiExtensionRoot: path.join(repoRoot, 'web-ui', 'extension'),
            vscodeExtensionRoot: path.join(repoRoot, 'vscode-agentchatbus'),
        };
    }

    return null;
}
