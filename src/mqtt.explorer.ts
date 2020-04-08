import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper';
import {
  MQTT_CLIENT_INSTANCE, MQTT_OPTION_PROVIDER,
  MQTT_SUBSCRIBE_OPTIONS,
  MQTT_SUBSCRIBER_PARAMS,
} from './mqtt.constants';
import { Client } from 'mqtt';
import { Packet } from 'mqtt-packet';
import { getTransform } from './mqtt.transform';
import {
  MqttModuleOptions,
  MqttSubscribeOptions,
  MqttSubscriber,
  MqttSubscriberParameter,
} from './mqtt.interface';

@Injectable()
export class MqttExplorer implements OnModuleInit {
  subscribers: MqttSubscriber[];

  constructor(
    private readonly discoveryService: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    private readonly logger: Logger,
    private readonly reflector: Reflector,
    @Inject(MQTT_CLIENT_INSTANCE) private readonly client: Client,
    @Inject(MQTT_OPTION_PROVIDER) private readonly options: MqttModuleOptions,
  ) {
    this.subscribers = [];
  }

  onModuleInit() {
    this.logger.log('MqttModule dependencies initialized');
    this.explore();
  }

  preprocess(options: MqttSubscribeOptions): string | string[] {
    const processTopic = (topic) => {
      const queue = typeof options.queue === 'boolean' ? options.queue : this.options.queue;
      const shared = typeof options.shared === 'string' ? options.shared : this.options.shared;
      topic = topic.replace('$queue/', '')
        .replace(/^\$share\/([A-Za-z0-9]+)\//, '');
      if (queue) {
        return `$queue/${topic}`;
      }

      if (shared) {
        return `$shared/${shared}/${topic}`;
      }
    };
    if (Array.isArray(options.topic)) {
      return options.topic.map(processTopic);
    } else {
      return processTopic(options.topic);
    }
  }

  subscribe(options: MqttSubscribeOptions, parameters: MqttSubscriberParameter[], handle) {
    this.client.subscribe(this.preprocess(options), err => {
      if (!err) {
        // put it into this.subscribers;
        (Array.isArray(options.topic) ? options.topic : [options.topic])
          .forEach(topic => {
            this.subscribers.push({
              topic,
              route: topic.replace('$queue/', '')
                .replace(/^\$share\/([A-Za-z0-9]+)\//, ''),
              regexp: MqttExplorer.topicToRegexp(topic),
              handle,
              options,
              parameters,
            });
          });
      } else {
        this.logger.error(
          `subscribe topic [${options.topic} failed]`,
        );
      }
    });
  }

  explore() {
    const providers: InstanceWrapper[] = this.discoveryService.getProviders();
    providers.forEach((wrapper: InstanceWrapper) => {
      const { instance } = wrapper;
      if (!instance) {
        return;
      }
      this.metadataScanner.scanFromPrototype(
        instance,
        Object.getPrototypeOf(instance),
        key => {
          const subscribeOptions: MqttSubscribeOptions = this.reflector.get(
            MQTT_SUBSCRIBE_OPTIONS,
            instance[key],
          );
          const parameters = this.reflector.get(
            MQTT_SUBSCRIBER_PARAMS,
            instance[key],
          );
          if (subscribeOptions) {
            this.subscribe(subscribeOptions, parameters, instance[key]);
          }
        },
      );
    });
    this.client.on(
      'message',
      (topic: string, payload: Buffer, packet: Packet) => {
        const subscriber = this.getSubscriber(topic);
        if (subscriber) {
          const parameters = subscriber.parameters || [];
          const scatterParameters: MqttSubscriberParameter[] = [];
          for (const parameter of parameters) {
            scatterParameters[parameter.index] = parameter;
          }
          const transform = getTransform(subscriber.options.transform);
          subscriber.handle(
            ...scatterParameters.map(parameter => {
              switch (parameter?.type) {
                case 'payload':
                  return transform(payload);
                case 'topic':
                  return topic;
                case 'packet':
                  return packet;
                case 'params':
                  return MqttExplorer.matchGroups(topic, subscriber.regexp);
                default:
                  return null;
              }
            }),
          );
        }
      },
    );
  }

  private getSubscriber(topic: string): MqttSubscriber | null {
    for (const subscriber of this.subscribers) {
      subscriber.regexp.lastIndex = 0;
      if (subscriber.regexp.test(topic)) {
        return subscriber;
      }
    }
    return null;
  }

  private static topicToRegexp(topic: string) {
    // compatible with emqtt
    return new RegExp(
      '^' +
      topic
        .replace('$queue/', '')
        .replace(/^\$share\/([A-Za-z0-9]+)\//, '')
        .replace(/([\[\]\?\(\)\\\\$\^\*\.|])/g, '\\$1')
        .replace(/\+/g, '([^/]+)')
        .replace(/\/#$/, '(/.*)?') +
      '$',
      'y',
    );
  }

  private static matchGroups(str: string, regex: RegExp) {
    regex.lastIndex = 0;
    let m = regex.exec(str);
    const matches: string[] = [];

    while (m !== null) {
      // This is necessary to avoid infinite loops with zero-width matches
      if (m.index === regex.lastIndex) {
        regex.lastIndex++;
      }

      // The result can be accessed through the `m`-variable.
      m.forEach((match, groupIndex) => {
        if (groupIndex !== 0) {
          matches.push(match);
        }
      });
      m = regex.exec(str);
    }
    return matches;
  }
}
