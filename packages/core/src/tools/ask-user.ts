/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  type ToolResult,
  Kind,
  type ToolAskUserConfirmationDetails,
  type ToolConfirmationPayload,
  ToolConfirmationOutcome,
} from './tools.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { QuestionType, type Question } from '../confirmation-bus/types.js';
import { ASK_USER_TOOL_NAME, ASK_USER_DISPLAY_NAME } from './tool-names.js';
import { ApprovalMode } from '../policy/types.js';
import type { Config } from '../config/config.js';

export interface AskUserParams {
  questions: Question[];
}

export class AskUserTool extends BaseDeclarativeTool<
  AskUserParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    messageBus: MessageBus,
  ) {
    super(
      ASK_USER_TOOL_NAME,
      ASK_USER_DISPLAY_NAME,
      'Ask the user one or more questions to gather preferences, clarify requirements, or make decisions.',
      Kind.Communicate,
      {
        type: 'object',
        required: ['questions'],
        properties: {
          questions: {
            type: 'array',
            minItems: 1,
            maxItems: 4,
            items: {
              type: 'object',
              required: ['question', 'header'],
              properties: {
                question: {
                  type: 'string',
                  description:
                    'The complete question to ask the user. Should be clear, specific, and end with a question mark.',
                },
                header: {
                  type: 'string',
                  maxLength: 16,
                  description:
                    'Very short label displayed as a chip/tag (max 16 chars). Examples: "Auth method", "Library", "Approach".',
                },
                type: {
                  type: 'string',
                  enum: ['choice', 'text', 'yesno'],
                  default: 'choice',
                  description:
                    "Question type: 'choice' (default) for multiple-choice with options, 'text' for free-form input, 'yesno' for Yes/No confirmation.",
                },
                options: {
                  type: 'array',
                  description:
                    "The selectable choices for 'choice' type questions. Provide 2-4 options. An 'Other' option is automatically added. Not needed for 'text' or 'yesno' types.",
                  items: {
                    type: 'object',
                    required: ['label', 'description'],
                    properties: {
                      label: {
                        type: 'string',
                        description:
                          'The display text for this option (1-5 words). Example: "OAuth 2.0"',
                      },
                      description: {
                        type: 'string',
                        description:
                          'Brief explanation of this option. Example: "Industry standard, supports SSO"',
                      },
                    },
                  },
                },
                multiSelect: {
                  type: 'boolean',
                  description:
                    "Only applies when type='choice'. Set to true to allow selecting multiple options.",
                },
                placeholder: {
                  type: 'string',
                  description:
                    "Hint text shown in the input field. For type='text', shown in the main input. For type='choice', shown in the 'Other' custom input.",
                },
              },
            },
          },
        },
      },
      messageBus,
    );
  }

  protected override validateToolParamValues(
    params: AskUserParams,
  ): string | null {
    if (!params.questions || params.questions.length === 0) {
      return 'At least one question is required.';
    }

    for (let i = 0; i < params.questions.length; i++) {
      const q = params.questions[i];
      const questionType = q.type ?? QuestionType.CHOICE;

      // Validate that 'choice' type has options
      if (questionType === QuestionType.CHOICE) {
        if (!q.options || q.options.length < 2) {
          return `Question ${i + 1}: type='choice' requires 'options' array with 2-4 items.`;
        }
        if (q.options.length > 4) {
          return `Question ${i + 1}: 'options' array must have at most 4 items.`;
        }
      }

      // Validate option structure if provided
      if (q.options) {
        for (let j = 0; j < q.options.length; j++) {
          const opt = q.options[j];
          if (
            !opt.label ||
            typeof opt.label !== 'string' ||
            !opt.label.trim()
          ) {
            return `Question ${i + 1}, option ${j + 1}: 'label' is required and must be a non-empty string.`;
          }
          if (
            opt.description === undefined ||
            typeof opt.description !== 'string'
          ) {
            return `Question ${i + 1}, option ${j + 1}: 'description' is required and must be a string.`;
          }
        }
      }
    }

    return null;
  }

  protected createInvocation(
    params: AskUserParams,
    messageBus: MessageBus,
    toolName: string,
    toolDisplayName: string,
  ): AskUserInvocation {
    return new AskUserInvocation(
      params,
      messageBus,
      toolName,
      toolDisplayName,
      this.config,
    );
  }
}

export class AskUserInvocation extends BaseToolInvocation<
  AskUserParams,
  ToolResult
> {
  private confirmationOutcome: ToolConfirmationOutcome | null = null;
  private userAnswers: { [questionIndex: string]: string } = {};

  constructor(
    params: AskUserParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
    private readonly config?: Config,
  ) {
    super(params, messageBus, toolName, toolDisplayName);
  }

  override async shouldConfirmExecute(
    _abortSignal: AbortSignal,
  ): Promise<ToolAskUserConfirmationDetails | false> {
    // Check if we're in YOLO mode
    if (this.config?.getApprovalMode() === ApprovalMode.YOLO) {
      // In YOLO mode, generate intelligent default answers and skip confirmation
      this.userAnswers = this.generateDefaultAnswers();
      this.confirmationOutcome = ToolConfirmationOutcome.ProceedOnce;
      return false;
    }

    const normalizedQuestions = this.params.questions.map((q) => ({
      ...q,
      type: q.type ?? QuestionType.CHOICE,
    }));

    return {
      type: 'ask_user',
      title: 'Ask User',
      questions: normalizedQuestions,
      onConfirm: async (
        outcome: ToolConfirmationOutcome,
        payload?: ToolConfirmationPayload,
      ) => {
        this.confirmationOutcome = outcome;
        if (payload && 'answers' in payload) {
          this.userAnswers = payload.answers;
        }
      },
    };
  }

  /**
   * Generates intelligent default answers for questions when in YOLO mode.
   * This provides sensible defaults instead of empty responses.
   */
  private generateDefaultAnswers(): { [questionIndex: string]: string } {
    const answers: { [questionIndex: string]: string } = {};

    this.params.questions.forEach((question, index) => {
      const questionType = question.type ?? QuestionType.CHOICE;

      switch (questionType) {
        case QuestionType.YESNO:
          // Default to "Yes" for yes/no questions in YOLO mode
          answers[index.toString()] = 'Yes';
          break;

        case QuestionType.CHOICE:
          // Select the first option for choice questions
          if (question.options && question.options.length > 0) {
            answers[index.toString()] = question.options[0].label;
          } else {
            answers[index.toString()] = 'First option';
          }
          break;

        case QuestionType.TEXT:
          // Provide a generic helpful response for text questions
          if (question.header) {
            switch (question.header.toLowerCase()) {
              case 'name':
              case 'title':
                answers[index.toString()] = 'Default';
                break;
              case 'description':
                answers[index.toString()] = 'Generated in YOLO mode';
                break;
              case 'version':
                answers[index.toString()] = '1.0.0';
                break;
              case 'author':
                answers[index.toString()] = 'User';
                break;
              default:
                answers[index.toString()] = 'Auto-selected in YOLO mode';
            }
          } else {
            answers[index.toString()] = 'Auto-selected in YOLO mode';
          }
          break;

        default:
          answers[index.toString()] = 'Auto-selected in YOLO mode';
          break;
      }
    });

    return answers;
  }

  getDescription(): string {
    return `Asking user: ${this.params.questions.map((q) => q.question).join(', ')}`;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    if (this.confirmationOutcome === ToolConfirmationOutcome.Cancel) {
      return {
        llmContent: 'User dismissed ask_user dialog without answering.',
        returnDisplay: 'User dismissed dialog',
      };
    }

    const answerEntries = Object.entries(this.userAnswers);
    const hasAnswers = answerEntries.length > 0;

    // Check if we're in YOLO mode and generated default answers
    const isYoloMode = this.config?.getApprovalMode() === ApprovalMode.YOLO;
    const hasDefaultAnswers = isYoloMode && hasAnswers;

    const returnDisplay = hasAnswers
      ? `**${hasDefaultAnswers ? 'YOLO mode auto-answered:' : 'User answered:'}**\n${answerEntries
          .map(([index, answer]) => {
            const question = this.params.questions[parseInt(index, 10)];
            const category = question?.header ?? `Q${index}`;
            return `  ${category} → ${answer}`;
          })
          .join('\n')}`
      : 'User submitted without answering questions.';

    return {
      llmContent: JSON.stringify({
        answers: this.userAnswers,
        yoloMode: isYoloMode,
        autoGenerated: hasDefaultAnswers,
      }),
      returnDisplay,
    };
  }
}
