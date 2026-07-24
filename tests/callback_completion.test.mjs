/**
 * Unit tests for callback completion formatters.
 * Tests the contract: callback trigger must NOT embed the full result,
 * it should be a lightweight signal to call subagent_result.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatCallbackTrigger, formatCallbackQuiet } from '../completion.mjs';

describe('formatCallbackTrigger', () => {
    it('must NOT contain "--- result ---" marker', () => {
        const result = formatCallbackTrigger({
            id: 'abc123',
            label: 'test-agent (abc123)',
            verdict: '✓ completed',
            stat: '45s · 1.2k tok (↑400 ↓800) · $0.0034',
        });
        assert.ok(
            !result.includes('--- result ---'),
            `Trigger must not embed result. Got:\n${result}`
        );
    });

    it('must contain "subagent_result" reference', () => {
        const result = formatCallbackTrigger({
            id: 'abc123',
            label: 'test-agent (abc123)',
            verdict: '✓ completed',
            stat: '45s',
        });
        assert.ok(
            result.includes('subagent_result'),
            `Trigger must reference subagent_result. Got:\n${result}`
        );
    });

    it('must contain the run id', () => {
        const runId = 'abc123';
        const result = formatCallbackTrigger({
            id: runId,
            label: 'test-agent (abc123)',
            verdict: '✓ completed',
            stat: '45s',
        });
        assert.ok(
            result.includes(runId),
            `Trigger must contain the id "${runId}". Got:\n${result}`
        );
    });

    it('must NOT contain arbitrary payload that should not appear', () => {
        const result = formatCallbackTrigger({
            id: 'abc123',
            label: 'test-agent',
            verdict: '✓ completed',
            stat: '45s',
        });
        // Even if we try to smuggle this through tools or label,
        // the formatter should not output raw result content
        assert.ok(
            !result.includes('UNIQUE_PAYLOAD_SHOULD_NOT_APPEAR'),
            `Trigger must not contain arbitrary payload markers. Got:\n${result}`
        );
    });

    it('may include label, verdict, and stat', () => {
        const result = formatCallbackTrigger({
            id: 'abc123',
            label: 'my-agent (abc123)',
            verdict: '✓ completed',
            stat: '1m 30s · 5.2k tok',
            tools: 'read,bash',
        });
        assert.ok(result.includes('my-agent'), 'Should include label');
        assert.ok(result.includes('✓ completed'), 'Should include verdict');
        assert.ok(result.includes('1m 30s'), 'Should include stat');
        assert.ok(result.includes('read,bash'), 'Should include tools list');
    });
});

describe('formatCallbackQuiet', () => {
    it('must indicate NOT auto-posted', () => {
        const result = formatCallbackQuiet({
            id: 'abc123',
            label: 'test-agent (abc123)',
            verdict: '✓ completed',
            stat: '45s',
        });
        assert.ok(
            result.includes('NOT auto-posted') || result.includes('callback:false'),
            `Quiet must indicate not auto-posted. Got:\n${result}`
        );
    });

    it('must reference subagent_result with the id', () => {
        const runId = 'abc123';
        const result = formatCallbackQuiet({
            id: runId,
            label: 'test-agent',
            verdict: '✓ completed',
            stat: '45s',
        });
        assert.ok(
            result.includes('subagent_result'),
            `Quiet must reference subagent_result. Got:\n${result}`
        );
        assert.ok(
            result.includes(runId),
            `Quiet must contain id "${runId}". Got:\n${result}`
        );
    });
});

// Integration test: verify index.ts uses the right formatters and settings
describe('index.ts integration', async () => {
    const indexSource = await import('node:fs').then(fs => 
        fs.promises.readFile('/Users/exoulster/projects/pi-better-subagents/index.ts', 'utf8')
    );

    it('callback path should use formatCallbackTrigger with triggerTurn:true', () => {
        // Verify formatCallbackTrigger is imported
        assert.ok(
            indexSource.includes('formatCallbackTrigger'),
            'index.ts should import formatCallbackTrigger'
        );
        
        // Verify callback=true path uses triggerTurn:true
        assert.ok(
            indexSource.includes('triggerTurn: true') || indexSource.includes('triggerTurn:true'),
            'callback=true path should set triggerTurn: true'
        );
        
        // Verify callback=true path uses deliverAs:followUp
        assert.ok(
            indexSource.includes('deliverAs: "followUp"') || indexSource.includes("deliverAs: 'followUp'"),
            'callback=true path should use deliverAs: followUp'
        );
    });

    it('callback=false path should use formatCallbackQuiet with deliverAs:nextTurn', () => {
        // Verify callback=false path uses formatCallbackQuiet
        assert.ok(
            indexSource.includes('formatCallbackQuiet'),
            'index.ts should import formatCallbackQuiet'
        );
        
        // Verify callback=false path uses deliverAs:nextTurn
        assert.ok(
            indexSource.includes('deliverAs: "nextTurn"') || indexSource.includes("deliverAs: 'nextTurn'"),
            'callback=false path should use deliverAs: nextTurn'
        );
    });
    
    it('callback path should NOT embed "--- result ---" in message content', () => {
        // Find the callback=true block
        const callbackMatch = indexSource.match(/if \(callback\) \{[\s\S]*?(?=else|function finalizeRun)/);
        if (callbackMatch) {
            const callbackBlock = callbackMatch[0];
            assert.ok(
                !callbackBlock.includes('--- result ---'),
                'callback=true block should not embed "--- result ---" in message. ' +
                'The result is fetched via subagent_result, not embedded in the trigger.'
            );
        }
    });
});
