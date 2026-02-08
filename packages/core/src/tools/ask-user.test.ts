/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AskUserTool } from './ask-user.js';
import { QuestionType, type Question } from '../confirmation-bus/types.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { ToolConfirmationOutcome } from './tools.js';
import { ApprovalMode } from '../policy/types.js';
import type { Config } from '../config/config.js';

describe('AskUserTool', () => {
  let mockMessageBus: MessageBus;
  let mockConfig: Config;
  let tool: AskUserTool;

  beforeEach(() => {
    mockMessageBus = {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    } as unknown as MessageBus;

    mockConfig = {
      getApprovalMode: vi.fn().mockReturnValue(ApprovalMode.DEFAULT),
      getTargetDir: vi.fn().mockReturnValue('/test'),
      getGeminiClient: vi.fn(),
      getBaseLlmClient: vi.fn(),
      setApprovalMode: vi.fn(),
      // Add other required Config methods as needed
    } as unknown as Config;

    tool = new AskUserTool(mockConfig, mockMessageBus);
  });

  it('should have correct metadata', () => {
    expect(tool.name).toBe('ask_user');
    expect(tool.displayName).toBe('Ask User');
  });

  describe('validateToolParams', () => {
    it('should return error if questions is missing', () => {
      // @ts-expect-error - Intentionally invalid params
      const result = tool.validateToolParams({});
      expect(result).toContain("must have required property 'questions'");
    });

    it('should return error if questions array is empty', () => {
      const result = tool.validateToolParams({ questions: [] });
      expect(result).toContain('must NOT have fewer than 1 items');
    });

    it('should return error if questions array exceeds max', () => {
      const questions = Array(5).fill({
        question: 'Test?',
        header: 'Test',
        options: [
          { label: 'A', description: 'A' },
          { label: 'B', description: 'B' },
        ],
      });
      const result = tool.validateToolParams({ questions });
      expect(result).toContain('must NOT have more than 4 items');
    });

    it('should return error if question field is missing', () => {
      const result = tool.validateToolParams({
        questions: [{ header: 'Test' } as unknown as Question],
      });
      expect(result).toContain("must have required property 'question'");
    });

    it('should return error if header field is missing', () => {
      const result = tool.validateToolParams({
        questions: [{ question: 'Test?' } as unknown as Question],
      });
      expect(result).toContain("must have required property 'header'");
    });

    it('should return error if header exceeds max length', () => {
      const result = tool.validateToolParams({
        questions: [{ question: 'Test?', header: 'This is way too long' }],
      });
      expect(result).toContain('must NOT have more than 16 characters');
    });

    it('should return error if options has fewer than 2 items', () => {
      const result = tool.validateToolParams({
        questions: [
          {
            question: 'Test?',
            header: 'Test',
            options: [{ label: 'A', description: 'A' }],
          },
        ],
      });
      expect(result).toContain(
        "type='choice' requires 'options' array with 2-4 items",
      );
    });

    it('should return error if options has more than 4 items', () => {
      const result = tool.validateToolParams({
        questions: [
          {
            question: 'Test?',
            header: 'Test',
            options: [
              { label: 'A', description: 'A' },
              { label: 'B', description: 'B' },
              { label: 'C', description: 'C' },
              { label: 'D', description: 'D' },
              { label: 'E', description: 'E' },
            ],
          },
        ],
      });
      expect(result).toContain("'options' array must have at most 4 items");
    });

    it('should return null for valid params', () => {
      const result = tool.validateToolParams({
        questions: [
          {
            question: 'Which approach?',
            header: 'Approach',
            options: [
              { label: 'A', description: 'Option A' },
              { label: 'B', description: 'Option B' },
            ],
          },
        ],
      });
      expect(result).toBeNull();
    });

    it('should return error if choice type has no options', () => {
      const result = tool.validateToolParams({
        questions: [
          {
            question: 'Pick one?',
            header: 'Choice',
            type: QuestionType.CHOICE,
          },
        ],
      });
      expect(result).toContain("type='choice' requires 'options'");
    });

    it('should return error if type is omitted and options missing (defaults to choice)', () => {
      const result = tool.validateToolParams({
        questions: [
          {
            question: 'Pick one?',
            header: 'Choice',
            // type omitted, defaults to 'choice'
            // options missing
          },
        ],
      });
      expect(result).toContain("type='choice' requires 'options'");
    });

    it('should accept text type without options', () => {
      const result = tool.validateToolParams({
        questions: [
          {
            question: 'Enter your name?',
            header: 'Name',
            type: QuestionType.TEXT,
          },
        ],
      });
      expect(result).toBeNull();
    });

    it('should accept yesno type without options', () => {
      const result = tool.validateToolParams({
        questions: [
          {
            question: 'Do you want to proceed?',
            header: 'Confirm',
            type: QuestionType.YESNO,
          },
        ],
      });
      expect(result).toBeNull();
    });

    it('should accept placeholder for choice type', () => {
      const result = tool.validateToolParams({
        questions: [
          {
            question: 'Which language?',
            header: 'Language',
            type: QuestionType.CHOICE,
            options: [
              { label: 'TypeScript', description: 'Typed JavaScript' },
              { label: 'JavaScript', description: 'Dynamic language' },
            ],
            placeholder: 'Type another language...',
          },
        ],
      });
      expect(result).toBeNull();
    });

    it('should return error if option has empty label', () => {
      const result = tool.validateToolParams({
        questions: [
          {
            question: 'Pick one?',
            header: 'Choice',
            options: [
              { label: '', description: 'Empty label' },
              { label: 'B', description: 'Option B' },
            ],
          },
        ],
      });
      expect(result).toContain("'label' is required");
    });

    it('should return error if option is missing description', () => {
      const result = tool.validateToolParams({
        questions: [
          {
            question: 'Pick one?',
            header: 'Choice',
            options: [
              { label: 'A' } as { label: string; description: string },
              { label: 'B', description: 'Option B' },
            ],
          },
        ],
      });
      expect(result).toContain("must have required property 'description'");
    });
  });

  describe('shouldConfirmExecute', () => {
    it('should return confirmation details with normalized questions', async () => {
      const questions = [
        {
          question: 'How should we proceed with this task?',
          header: 'Approach',
          options: [
            {
              label: 'Quick fix (Recommended)',
              description:
                'Apply the most direct solution to resolve the immediate issue.',
            },
            {
              label: 'Comprehensive refactor',
              description:
                'Restructure the affected code for better long-term maintainability.',
            },
          ],
          multiSelect: false,
        },
      ];

      const invocation = tool.build({ questions });
      const details = await invocation.shouldConfirmExecute(
        new AbortController().signal,
      );

      expect(details).not.toBe(false);
      if (details && details.type === 'ask_user') {
        expect(details.title).toBe('Ask User');
        expect(details.questions).toEqual(
          questions.map((q) => ({
            ...q,
            type: QuestionType.CHOICE,
          })),
        );
        expect(typeof details.onConfirm).toBe('function');
      } else {
        // Type guard for TypeScript
        expect(details).toBeTruthy();
      }
    });

    it('should normalize question type to CHOICE when omitted', async () => {
      const questions = [
        {
          question: 'Which approach?',
          header: 'Approach',
          options: [
            { label: 'Option A', description: 'First option' },
            { label: 'Option B', description: 'Second option' },
          ],
        },
      ];

      const invocation = tool.build({ questions });
      const details = await invocation.shouldConfirmExecute(
        new AbortController().signal,
      );

      if (details && details.type === 'ask_user') {
        expect(details.questions[0].type).toBe(QuestionType.CHOICE);
      }
    });
  });

  describe('execute', () => {
    it('should return user answers after confirmation', async () => {
      const questions = [
        {
          question: 'How should we proceed with this task?',
          header: 'Approach',
          options: [
            {
              label: 'Quick fix (Recommended)',
              description:
                'Apply the most direct solution to resolve the immediate issue.',
            },
            {
              label: 'Comprehensive refactor',
              description:
                'Restructure the affected code for better long-term maintainability.',
            },
          ],
          multiSelect: false,
        },
      ];

      const invocation = tool.build({ questions });
      const details = await invocation.shouldConfirmExecute(
        new AbortController().signal,
      );

      // Simulate confirmation with answers
      if (details && 'onConfirm' in details) {
        const answers = { '0': 'Quick fix (Recommended)' };
        await details.onConfirm(ToolConfirmationOutcome.ProceedOnce, {
          answers,
        });
      }

      const result = await invocation.execute(new AbortController().signal);
      expect(result.returnDisplay).toContain('User answered:');
      expect(result.returnDisplay).toContain(
        '  Approach → Quick fix (Recommended)',
      );
      expect(JSON.parse(result.llmContent as string)).toEqual({
        answers: { '0': 'Quick fix (Recommended)' },
      });
    });

    it('should display message when user submits without answering', async () => {
      const questions = [
        {
          question: 'Which approach?',
          header: 'Approach',
          options: [
            { label: 'Option A', description: 'First option' },
            { label: 'Option B', description: 'Second option' },
          ],
        },
      ];

      const invocation = tool.build({ questions });
      const details = await invocation.shouldConfirmExecute(
        new AbortController().signal,
      );

      // Simulate confirmation with empty answers
      if (details && 'onConfirm' in details) {
        await details.onConfirm(ToolConfirmationOutcome.ProceedOnce, {
          answers: {},
        });
      }

      const result = await invocation.execute(new AbortController().signal);
      expect(result.returnDisplay).toBe(
        'User submitted without answering questions.',
      );
      expect(JSON.parse(result.llmContent as string)).toEqual({ answers: {} });
    });

    it('should handle cancellation', async () => {
      const invocation = tool.build({
        questions: [
          {
            question: 'Which sections of the documentation should be updated?',
            header: 'Docs',
            options: [
              {
                label: 'User Guide',
                description: 'Update the main user-facing documentation.',
              },
              {
                label: 'API Reference',
                description: 'Update the detailed API documentation.',
              },
            ],
            multiSelect: true,
          },
        ],
      });

      const details = await invocation.shouldConfirmExecute(
        new AbortController().signal,
      );

      // Simulate cancellation
      if (details && 'onConfirm' in details) {
        await details.onConfirm(ToolConfirmationOutcome.Cancel);
      }

      const result = await invocation.execute(new AbortController().signal);
      expect(result.returnDisplay).toBe('User dismissed dialog');
      expect(result.llmContent).toBe(
        'User dismissed ask_user dialog without answering.',
      );
    });
  });

  describe('YOLO mode', () => {
    it('should auto-answer with intelligent defaults in YOLO mode', async () => {
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);

      const invocation = tool.build({
        questions: [
          {
            question: 'Should we proceed?',
            header: 'Confirmation',
            type: 'yesno',
          },
          {
            question: 'Which approach do you prefer?',
            header: 'Method',
            type: 'choice',
            options: [
              { label: 'Option A', description: 'First option' },
              { label: 'Option B', description: 'Second option' },
            ],
          },
          {
            question: 'What is the project name?',
            header: 'Name',
            type: 'text',
          },
        ],
      });

      // In YOLO mode, shouldConfirmExecute should return false (no confirmation needed)
      const details = await invocation.shouldConfirmExecute(
        new AbortController().signal,
      );
      expect(details).toBe(false);

      const result = await invocation.execute(new AbortController().signal);

      // Should contain auto-generated answers
      expect(result.returnDisplay).toContain('YOLO mode auto-answered');
      expect(result.returnDisplay).toContain('Confirmation → Yes'); // yesno defaults to Yes
      expect(result.returnDisplay).toContain('Method → Option A'); // choice defaults to first option
      expect(result.returnDisplay).toContain('Name → Default'); // text defaults based on header

      const parsedContent = JSON.parse(result.llmContent as string);
      expect(parsedContent.yoloMode).toBe(true);
      expect(parsedContent.autoGenerated).toBe(true);
      expect(parsedContent.answers).toEqual({
        '0': 'Yes',
        '1': 'Option A',
        '2': 'Default',
      });
    });

    it('should handle different question types correctly in YOLO mode', async () => {
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);

      const invocation = tool.build({
        questions: [
          {
            question: 'Enter version:',
            header: 'Version',
            type: 'text',
          },
          {
            question: 'Enter description:',
            header: 'description',
            type: 'text',
          },
        ],
      });

      await invocation.shouldConfirmExecute(new AbortController().signal);
      const result = await invocation.execute(new AbortController().signal);

      const parsedContent = JSON.parse(result.llmContent as string);
      expect(parsedContent.answers['0']).toBe('1.0.0'); // Version defaults to semantic version
      expect(parsedContent.answers['1']).toBe('Generated in YOLO mode'); // description defaults
    });

    it('should work normally when not in YOLO mode', async () => {
      mockConfig.getApprovalMode = vi
        .fn()
        .mockReturnValue(ApprovalMode.DEFAULT);

      const invocation = tool.build({
        questions: [
          {
            question: 'Choose an option?',
            header: 'Choice',
            type: 'choice',
            options: [
              { label: 'Option 1', description: 'First' },
              { label: 'Option 2', description: 'Second' },
            ],
          },
        ],
      });

      const details = await invocation.shouldConfirmExecute(
        new AbortController().signal,
      );

      // Should not be false - should return confirmation details for normal mode
      expect(details).not.toBe(false);
      if (details && 'onConfirm' in details) {
        await details.onConfirm(ToolConfirmationOutcome.ProceedOnce, {
          answers: { '0': 'Option 2' },
        });
      }

      const result = await invocation.execute(new AbortController().signal);

      const parsedContent = JSON.parse(result.llmContent as string);
      expect(parsedContent.yoloMode).toBe(false);
      expect(parsedContent.autoGenerated).toBe(false);
      expect(parsedContent.answers).toEqual({ '0': 'Option 2' });
      expect(result.returnDisplay).toContain('User answered:');
    });
  });
});
