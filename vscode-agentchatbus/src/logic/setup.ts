export type SetupStepDefinition = {
    label: string;
    icon?: string;
    description?: string;
};

export function createInitialSetupSteps(): SetupStepDefinition[] {
    return [
        {
            label: 'Starting AgentChatBus...',
            icon: 'play',
        },
    ];
}

export function appendSetupLogStep(
    existingSteps: SetupStepDefinition[],
    message: string,
    icon?: string,
    description?: string
): SetupStepDefinition[] {
    return [
        ...existingSteps,
        {
            label: message,
            icon,
            description,
        },
    ];
}

export function replaceSetupSteps(stepLabels: SetupStepDefinition[]): SetupStepDefinition[] {
    return stepLabels.map((step) => ({
        label: step.label,
        ...(step.icon !== undefined ? { icon: step.icon } : {}),
        ...(step.description !== undefined ? { description: step.description } : {}),
    }));
}

export function formatSetupStepLabel(originalLabel: string, startTime: number, nowMs = Date.now()): string {
    const elapsed = ((nowMs - startTime) / 1000).toFixed(1);
    return `[${elapsed}s] ${originalLabel}`;
}
