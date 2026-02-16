import { Injectable } from '@nestjs/common';
import { AutopostRepository } from '@gitroom/nestjs-libraries/database/prisma/autopost/autopost.repository';
import { AutopostDto } from '@gitroom/nestjs-libraries/dtos/autopost/autopost.dto';
import dayjs from 'dayjs';
import { END, START, StateGraph } from '@langchain/langgraph';
import { AutoPost, Integration } from '@prisma/client';
import { BaseMessage } from '@langchain/core/messages';
import striptags from 'striptags';
import { ChatOpenAI, DallEAPIWrapper } from '@langchain/openai';
import { JSDOM } from 'jsdom';
import { z } from 'zod';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import Parser from 'rss-parser';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { TemporalService } from 'nestjs-temporal-core';
import { TypedSearchAttributes } from '@temporalio/common';
import {
  organizationId,
} from '@gitroom/nestjs-libraries/temporal/temporal.search.attribute';
import { resolveOpenAiConfig } from '@gitroom/nestjs-libraries/openai/openai.config';
const parser = new Parser();

interface WorkflowChannelsState {
  messages: BaseMessage[];
  orgId: string;
  posts?: Array<{
    url: string;
    content: string;
    description: string;
  }>;
}

const openAiConfig = resolveOpenAiConfig();
const model = new ChatOpenAI({
  configuration: { baseURL: openAiConfig.baseURL },
  apiKey: openAiConfig.apiKey,
  model: openAiConfig.model,
  temperature: 0.7,
});

const dalle = new DallEAPIWrapper({
  configuration: { baseURL: openAiConfig.baseURL },
  apiKey: openAiConfig.apiKey,
  model: openAiConfig.imageModel,
});

const generateContent = z.object({
  posts: z.array(
    z.object({
      url: z.string().describe('The URL of the post'),
      content: z.string().describe('The content of the post'),
      description: z.string().describe('A description of the post'),
    })
  ),
});

@Injectable()
export class AutopostService {
  constructor(
    private _autopostRepository: AutopostRepository,
    private _postsService: PostsService,
    private _integrationService: IntegrationService,
    private _temporalService: TemporalService
  ) {}

  static state = () =>
    new StateGraph<WorkflowChannelsState>({
      channels: {
        messages: {
          reducer: (currentState, updateValue) =>
            currentState.concat(updateValue),
          default: () => [],
        },
        orgId: null,
        posts: null,
      },
    });

  async generatePosts(state: WorkflowChannelsState) {
    const structuredOutput = model.withStructuredOutput(generateContent);
    const { posts } = await ChatPromptTemplate.fromTemplate(
      `
        You are an assistant that gets a list of RSS items and generate social media posts for them.
        Extract the most relevant posts and generate a social media post for each one.
        Make sure you don't generate more than 5 posts.
        Make sure the content is engaging and use simple english.
        Each post should have:
        - The URL of the post
        - The content of the post
        - A description of the post
        
        RSS items:
        {messages}
      `
    )
      .pipe(structuredOutput)
      .invoke({
        messages: state.messages.map((m) => m.content).join('\n'),
      });

    return { posts };
  }

  async createPosts(state: WorkflowChannelsState) {
    const integrations = await this._integrationService.getIntegrations(
      state.orgId
    );
    for (const post of state.posts || []) {
      const date = await this._postsService.findFreeDateTime(state.orgId);
      await this._postsService.createPost(state.orgId, {
        date: date.toISOString(),
        type: 'now',
        posts: integrations.map((i) => ({
          integrationId: i.id,
          content: post.content,
        })),
      });
    }

    return {};
  }

  async getAutoposts() {
    return this._autopostRepository.getAutoposts();
  }

  async createAutopost(orgId: string, autopostDto: AutopostDto) {
    const id = makeId(10);
    const create = await this._autopostRepository.createAutopost(
      orgId,
      autopostDto,
      id
    );

    await this._temporalService.createOrUpdateSchedule(
      'autopost-' + create.id,
      'autopost-workflow',
      create.frequency,
      {
        args: [create.id],
        searchAttributes: {
          [organizationId.name]: orgId,
        } as TypedSearchAttributes,
      }
    );

    return create;
  }

  async deleteAutopost(orgId: string, id: string) {
    await this._temporalService.deleteSchedule('autopost-' + id);
    return this._autopostRepository.deleteAutopost(orgId, id);
  }

  async updateAutopost(orgId: string, id: string, autopostDto: AutopostDto) {
    const update = await this._autopostRepository.updateAutopost(
      orgId,
      id,
      autopostDto
    );

    await this._temporalService.createOrUpdateSchedule(
      'autopost-' + update.id,
      'autopost-workflow',
      update.frequency,
      {
        args: [update.id],
        searchAttributes: {
          [organizationId.name]: orgId,
        } as TypedSearchAttributes,
      }
    );

    return update;
  }

  async runAutopost(id: string) {
    const autopost = await this._autopostRepository.getAutopostById(id);
    if (!autopost) {
      return;
    }

    const rss = await parser.parseURL(autopost.url);
    const state = AutopostService.state();
    const workflow = state
      .addNode('generate-posts', this.generatePosts.bind(this))
      .addNode('create-posts', this.createPosts.bind(this))
      .addEdge(START, 'generate-posts')
      .addEdge('generate-posts', 'create-posts')
      .addEdge('create-posts', END);

    const app = workflow.compile();
    return app.invoke({
      messages: rss.items.map((i) => ({
        content: `Title: ${i.title}\nDescription: ${striptags(
          i.contentSnippet || i.content || ''
        )}\nURL: ${i.link}`,
      })) as any,
      orgId: autopost.organizationId,
    });
  }
}
