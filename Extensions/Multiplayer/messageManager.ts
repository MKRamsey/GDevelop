namespace gdjs {
  declare var cordova: any;

  const logger = new gdjs.Logger('Multiplayer');

  class RecentlySeenCustomMessages {
    maxSize: number;
    cache: Set<string>;
    keys: string[];

    constructor(maxSize: number) {
      this.maxSize = maxSize;
      this.cache = new Set();
      this.keys = [];
    }

    has(key: string) {
      return this.cache.has(key);
    }

    add(key: string) {
      // If we are at the maximum size, remove the first key.
      if (this.cache.size >= this.maxSize) {
        const keyToRemove = this.keys.shift();
        if (keyToRemove) {
          this.cache.delete(keyToRemove);
        }
      }

      // Add the key to the end of the list.
      this.cache.add(key);
      this.keys.push(key);
    }
  }

  export namespace multiplayerMessageManager {
    // For testing purposes, you can simulate network latency and packet loss.
    // Adds x ms to all network messages, simulating a slow network.
    const SIMULATE_NETWORK_LATENCY_MS = 0; // In ms.
    // Gives a random chance of packet loss, simulating a bad network.
    const SIMULATE_NETWORK_PACKET_LOSS_CHANCE = 0; // Between 0 and 1, % of packets lost.
    // Adds a latency to random network messages, simulating sporadic network issues.
    const SIMULATE_NETWORK_RANDOM_SLOW_PACKET_CHANCE = 0; // Between 0 and 1, % of packets that will be slow.
    const SIMULATE_NETWORK_RANDOM_LATENCY_MS = 0; // In ms.

    const getTimeNow =
      window.performance && typeof window.performance.now === 'function'
        ? window.performance.now.bind(window.performance)
        : Date.now;
    const defaultMessageRetryTime = 200; // Time to wait before retrying a message that was not acknowledged, in ms.
    const defaultMaxRetries = 4; // Maximum number of retries before giving up on a message.

    // Make the processed messages an LRU cache, so that we can limit the number of messages we keep in memory,
    // as well as keep them in order.
    const processedCustomMessagesCache = new RecentlySeenCustomMessages(500);

    let expectedMessageAcknowledgements: {
      [messageName: string]: {
        [peerId: string]: {
          acknowledged: boolean;
          lastMessageSentAt: number;
          originalMessageName: string;
          originalData: any;
          numberOfRetries: number;
          maxNumberOfRetries: number;
          messageRetryTime: number;
          shouldCancelMessageIfTimesOut?: boolean;
        };
      };
    } = {};
    let _lastClockReceivedByInstance: { [instanceId: string]: number } = {};

    export const addExpectedMessageAcknowledgement = ({
      originalMessageName,
      originalData,
      expectedMessageName,
      otherPeerIds,
      shouldCancelMessageIfTimesOut,
      maxNumberOfRetries,
      messageRetryTime,
    }: {
      originalMessageName: string;
      originalData: any;
      expectedMessageName: string;
      otherPeerIds: string[];
      shouldCancelMessageIfTimesOut?: boolean;
      maxNumberOfRetries?: number;
      messageRetryTime?: number;
    }) => {
      if (!gdjs.multiplayer.isGameRunning) {
        // This can happen if objects are destroyed at the end of the scene.
        // We should not add expected messages in this case.
        return;
      }

      if (!expectedMessageAcknowledgements[expectedMessageName]) {
        expectedMessageAcknowledgements[expectedMessageName] = {};
      }

      logger.info(
        `Adding expected message ${expectedMessageName} from ${otherPeerIds.join(
          ', '
        )}.`
      );

      otherPeerIds.forEach((peerId) => {
        expectedMessageAcknowledgements[expectedMessageName][peerId] = {
          acknowledged: false,
          lastMessageSentAt: getTimeNow(),
          originalMessageName,
          originalData,
          shouldCancelMessageIfTimesOut,
          numberOfRetries: 0,
          maxNumberOfRetries: maxNumberOfRetries || defaultMaxRetries,
          messageRetryTime: messageRetryTime || defaultMessageRetryTime,
        };
      });
    };

    export const clearExpectedMessageAcknowledgements = () => {
      expectedMessageAcknowledgements = {};
      _lastClockReceivedByInstance = {};
    };

    /**
     * Main function to send messages to other players, via P2P.
     * Takes into account the simulation of network latency and packet loss.
     */
    export const sendDataTo = (
      peerId: string,
      messageName: string,
      data: Object
    ): void => {
      if (
        SIMULATE_NETWORK_PACKET_LOSS_CHANCE > 0 &&
        Math.random() < SIMULATE_NETWORK_PACKET_LOSS_CHANCE
      ) {
        return;
      }

      if (
        SIMULATE_NETWORK_RANDOM_SLOW_PACKET_CHANCE > 0 &&
        Math.random() < SIMULATE_NETWORK_RANDOM_SLOW_PACKET_CHANCE
      ) {
        setTimeout(() => {
          gdjs.evtTools.p2p.sendDataTo(
            peerId,
            messageName,
            JSON.stringify(data)
          );
        }, SIMULATE_NETWORK_RANDOM_LATENCY_MS);
        return;
      }

      if (SIMULATE_NETWORK_LATENCY_MS > 0) {
        setTimeout(() => {
          gdjs.evtTools.p2p.sendDataTo(
            peerId,
            messageName,
            JSON.stringify(data)
          );
        }, SIMULATE_NETWORK_LATENCY_MS);
        return;
      }

      gdjs.evtTools.p2p.sendDataTo(peerId, messageName, JSON.stringify(data));
    };

    const getInstanceFromNetworkId = ({
      runtimeScene,
      objectName,
      instanceNetworkId,
      instanceX,
      instanceY,
      shouldCreateIfNotFound,
    }: {
      runtimeScene: gdjs.RuntimeScene;
      objectName: string;
      instanceNetworkId: string;
      instanceX?: number;
      instanceY?: number;
      shouldCreateIfNotFound?: boolean;
    }): gdjs.RuntimeObject | null => {
      const instances = runtimeScene.getInstancesOf(objectName);
      if (!instances) {
        // object does not exist in the scene, cannot find the instance.
        return null;
      }
      let instance =
        instances.find(
          (instance) => instance.networkId === instanceNetworkId
        ) || null;

      if (!instance) {
        logger.info(
          `instance ${objectName} ${instanceNetworkId} not found with network ID, trying to find it with persistent UUID.`
        );
        instance =
          instances.find(
            (instance) =>
              // For objects created from the start, the network ID is not set yet.
              instance.persistentUuid &&
              instance.persistentUuid.substring(0, 8) === instanceNetworkId
          ) || null;

        if (instance) {
          logger.info(
            `instance ${objectName} ${instanceNetworkId} found with persistent UUID. Assigning network ID.`
          );
          // Set the network ID, as it was not set yet.
          instance.networkId = instanceNetworkId;
        }
      }

      // If we know the position of the object, we can try to find the closest instance not synchronized yet.
      if (!instance && instanceX !== undefined && instanceY !== undefined) {
        logger.info(
          `instance not found with network ID, trying to find it with position ${instanceX}/${instanceY}.`
        );
        // Instance not found, it must be a new object.
        // 2 cases :
        // - The object was only created on the other player's game, so we create it and assign it the network ID.
        // - The object may have been created on all sides at the same time, so we try to find instances
        //   of this object, that do not have a network ID yet, pick the one that is the closest to the
        //   position of the object created by the other player, and assign it the network ID to start
        //   synchronizing it.

        // Find all instances that have the MultiplayerObjectRuntimeBehavior and no network ID yet.
        const instancesWithoutNetworkId = instances.filter(
          (instance) =>
            instance.hasBehavior('MultiplayerObject') && !instance.networkId
        );
        logger.info(
          `Found ${instancesWithoutNetworkId.length} instances for object ${objectName} with behavior MultiplayerObject and no network ID.`
        );
        if (instancesWithoutNetworkId.length > 0) {
          // Find the instance that is the closest to the position of the object created by the other player.
          const closestInstance = instancesWithoutNetworkId.reduce(
            (closestInstance, instance) => {
              const dx = instance.getX() - instanceX;
              const dy = instance.getY() - instanceY;
              const distance = dx * dx + dy * dy;
              if (distance < closestInstance.distance) {
                return { instance, distance };
              }
              return closestInstance;
            },
            {
              instance: instancesWithoutNetworkId[0],
              distance: Infinity,
            }
          ).instance;

          instance = closestInstance;
          instance.networkId = instanceNetworkId;
        }
      }

      // If we still did not find the instance, and we should create it if not found, then create it.
      if (!instance && shouldCreateIfNotFound) {
        logger.info(
          `Instance ${instanceNetworkId} still not found, Creating instance ${objectName}.`
        );
        const newInstance = runtimeScene.createObject(objectName);
        if (!newInstance) {
          // Object does not exist in the scene, cannot create the instance.
          return null;
        }

        newInstance.networkId = instanceNetworkId;
        instance = newInstance;
      }

      return instance;
    };

    const changeOwnerMessageNamePrefix = '#changeOwner';
    const changeOwnerMessageNameRegex =
      /#changeOwner#owner_(\d+)#object_(.+)#instance_(.+)/;
    export const createChangeOwnerMessage = ({
      objectOwner,
      objectName,
      instanceNetworkId,
      newObjectOwner,
      instanceX,
      instanceY,
    }: {
      objectOwner: number;
      objectName: string;
      instanceNetworkId: string;
      newObjectOwner: number;
      instanceX: number;
      instanceY: number;
    }): {
      messageName: string;
      messageData: {
        previousOwner: number;
        newOwner: number;
        instanceX: number;
        instanceY: number;
      };
    } => {
      return {
        messageName: `${changeOwnerMessageNamePrefix}#owner_${objectOwner}#object_${objectName}#instance_${instanceNetworkId}`,
        messageData: {
          previousOwner: objectOwner,
          newOwner: newObjectOwner,
          instanceX,
          instanceY,
        },
      };
    };
    const objectOwnerChangedMessageNamePrefix = '#ownerChanged';
    const objectOwnerChangedMessageNameRegex =
      /#ownerChanged#owner_(\d+)#object_(.+)#instance_(.+)/;
    export const createObjectOwnerChangedMessageNameFromChangeOwnerMessage = (
      messageName: string
    ): string => {
      return messageName.replace(
        changeOwnerMessageNamePrefix,
        objectOwnerChangedMessageNamePrefix
      );
    };
    export const handleChangeOwnerMessages = (
      runtimeScene: gdjs.RuntimeScene
    ) => {
      const p2pMessagesMap = gdjs.evtTools.p2p.getEvents();
      const objectMessageNamesArray = Array.from(p2pMessagesMap.keys());

      // When we receive ownership change messages, update the ownership of the objects in the scene.
      const objectOwnershipChangeMessageNames = objectMessageNamesArray.filter(
        (messageName) => messageName.startsWith(changeOwnerMessageNamePrefix)
      );
      objectOwnershipChangeMessageNames.forEach((messageName) => {
        if (gdjs.evtTools.p2p.onEvent(messageName, false)) {
          const data = JSON.parse(gdjs.evtTools.p2p.getEventData(messageName));
          const messageSender = gdjs.evtTools.p2p.getEventSender(messageName);
          logger.info(`Received message ${messageName} with data ${data}.`);
          if (data) {
            const matches = changeOwnerMessageNameRegex.exec(messageName);
            if (!matches) {
              return;
            }
            const objectName = matches[2];
            const instanceNetworkId = matches[3];
            const previousOwner = data.previousOwner;
            const newOwner = data.newOwner;

            const instance = getInstanceFromNetworkId({
              runtimeScene,
              objectName,
              instanceNetworkId,
              instanceX: data.instanceX,
              instanceY: data.instanceY,
              shouldCreateIfNotFound: true,
            });

            if (!instance) {
              // Instance not found, it must have been destroyed already.
              logger.info(
                `Instance ${instanceNetworkId} not found, it must have been destroyed.`
              );
              return;
            }

            const behavior = instance.getBehavior(
              'MultiplayerObject'
            ) as MultiplayerObjectRuntimeBehavior | null;
            if (!behavior) {
              logger.warn(
                `Object ${objectName} does not have the MultiplayerObjectBehavior, cannot change ownership.`
              );
              return;
            }

            const isPlayerTheServer =
              gdjs.multiplayer.playerPositionInLobby === 1;
            const currentPlayerObjectOwnership =
              behavior.getPlayerObjectOwnership();
            if (
              isPlayerTheServer &&
              currentPlayerObjectOwnership !== previousOwner
            ) {
              // We received an ownership change message for an object which thought the previous owner was different.
              // There may be some lag, and multiple ownership changes may have been sent by the other players.
              // As the server, let's not change the ownership and let the player revert it.
              logger.warn(
                `Object ${objectName} with instance network ID ${instanceNetworkId} does not have the expected previous owner. Expected ${previousOwner}, got ${currentPlayerObjectOwnership}.`
              );
              return;
            }

            // Force the ownership change.
            logger.info(
              `Changing ownership of object ${objectName} to ${newOwner}.`
            );
            behavior._playerNumber = newOwner;

            const ownerChangedMessageName =
              createObjectOwnerChangedMessageNameFromChangeOwnerMessage(
                messageName
              );

            logger.info(
              `Sending acknowledgment of ownership change of object ${objectName} with instance network ID ${instanceNetworkId} to ${messageSender}.`
            );
            // Once the object ownership has changed, we need to acknowledge it to the player who sent this message.
            sendDataTo(messageSender, ownerChangedMessageName, {});

            // If we are player number 1, we are the server,
            // so we need to relay the ownership change to others,
            // and expect an acknowledgment from them.
            if (gdjs.multiplayer.playerPositionInLobby === 1) {
              const connectedPeerIds = gdjs.evtTools.p2p.getAllPeers();
              // We don't need to send the message to the player who sent the ownership change message.
              const otherPeerIds = connectedPeerIds.filter(
                (peerId) => peerId !== messageSender
              );
              if (!otherPeerIds.length) {
                // No one else to relay the message to.
                return;
              }

              addExpectedMessageAcknowledgement({
                originalMessageName: messageName,
                originalData: data,
                expectedMessageName: ownerChangedMessageName,
                otherPeerIds,
                // As we are the server, we do not cancel the message if it times out.
                shouldCancelMessageIfTimesOut: false,
              });
              for (const peerId of otherPeerIds) {
                logger.info(
                  `Relaying ownership change of object ${objectName} with instance network ID ${instanceNetworkId} to ${peerId}.`
                );
                sendDataTo(peerId, messageName, data);
              }
            }
          }
        }
      });
    };

    const updateObjectMessageNamePrefix = '#update';
    const updateObjectMessageNameRegex =
      /#update#owner_(\d+)#object_(.+)#instance_(.+)/;
    export const createUpdateObjectMessage = ({
      objectOwner,
      objectName,
      instanceNetworkId,
      objectNetworkSyncData,
    }: {
      objectOwner: number;
      objectName: string;
      instanceNetworkId: string;
      objectNetworkSyncData: ObjectNetworkSyncData;
    }): {
      messageName: string;
      messageData: any;
    } => {
      return {
        messageName: `${updateObjectMessageNamePrefix}#owner_${objectOwner}#object_${objectName}#instance_${instanceNetworkId}`,
        messageData: objectNetworkSyncData,
      };
    };
    export const handleUpdateObjectMessages = (
      runtimeScene: gdjs.RuntimeScene
    ) => {
      const p2pMessagesMap = gdjs.evtTools.p2p.getEvents();
      const objectMessageNamesArray = Array.from(p2pMessagesMap.keys());

      // When we receive update messages, update the objects in the scene.
      const objectUpdateMessageNames = objectMessageNamesArray.filter(
        (messageName) => messageName.startsWith(updateObjectMessageNamePrefix)
      );
      objectUpdateMessageNames.forEach((messageName) => {
        if (gdjs.evtTools.p2p.onEvent(messageName, true)) {
          const data = JSON.parse(gdjs.evtTools.p2p.getEventData(messageName));
          const messageSender = gdjs.evtTools.p2p.getEventSender(messageName);
          if (data) {
            const matches = updateObjectMessageNameRegex.exec(messageName);
            if (!matches) {
              return;
            }
            const ownerPlayerNumber = parseInt(matches[1], 10);
            if (ownerPlayerNumber === gdjs.multiplayer.playerPositionInLobby) {
              // Do not update the object if we receive an message from ourselves.
              // Should not happen but be safe.
              return;
            }
            const objectName = matches[2];
            const instanceNetworkId = matches[3];

            const messageInstanceClock = data['_clock'];
            const lastClock =
              _lastClockReceivedByInstance[instanceNetworkId] || 0;
            if (messageInstanceClock <= lastClock) {
              // Ignore old messages, they may be arriving out of order because of lag.
              return;
            }

            const instance = getInstanceFromNetworkId({
              runtimeScene,
              objectName,
              instanceNetworkId,
              // This can happen if the object was created on the other player's game, and we need to create it.
              shouldCreateIfNotFound: true,
              instanceX: data.x,
              instanceY: data.y,
            });
            if (!instance) {
              // This should not happen as we should have created the instance if it did not exist.
              logger.error('Instance could not be found or created.');
              return;
            }

            // If the instance update is not done by the owner of the object, then something is wrong.
            // We should not update the object until we've received the ownership change message.
            const behavior = instance.getBehavior(
              'MultiplayerObject'
            ) as MultiplayerObjectRuntimeBehavior | null;
            if (!behavior) {
              logger.error(
                `Object ${objectName} does not have the MultiplayerObjectBehavior, cannot update it.`
              );
              // Object does not have the MultiplayerObjectBehavior, cannot update it.
              return;
            }

            if (behavior.getPlayerObjectOwnership() !== ownerPlayerNumber) {
              // The object is not owned by the player who sent the update message.
              // This can happen if the ownership change message has not arrived yet, and the player is trying to update the object.
              // Ignore the update message until the ownership change message arrives.
              logger.info(
                `Object ${objectName} with instance network ID ${instanceNetworkId} is not owned by the player who sent the update event. Expected ${behavior.getPlayerObjectOwnership()}, got ${ownerPlayerNumber}.`
              );
              return;
            }

            instance.updateFromObjectNetworkSyncData(data);
            _lastClockReceivedByInstance[instanceNetworkId] =
              messageInstanceClock;

            // If we are player number 1, we are the server,
            // so we need to relay the position to others except the player who sent the update message.
            if (gdjs.multiplayer.playerPositionInLobby === 1) {
              const connectedPeerIds = gdjs.evtTools.p2p.getAllPeers();
              // We don't need to send the message to the player who sent the update message.
              const otherPeerIds = connectedPeerIds.filter(
                (peerId) => peerId !== messageSender
              );
              if (!otherPeerIds.length) {
                // No one else to relay the message to.
                return;
              }

              for (const peerId of otherPeerIds) {
                logger.info(
                  `Relaying position of object ${objectName} with instance network ID ${instanceNetworkId} to ${peerId}.`
                );
                sendDataTo(peerId, messageName, data);
              }
            }
          }
        }
      });
    };

    const getRegexFromAckMessageName = (messageName: string) => {
      if (messageName.startsWith(objectDestroyedMessageNamePrefix)) {
        return objectDestroyedMessageNameRegex;
      } else if (messageName.startsWith(objectOwnerChangedMessageNamePrefix)) {
        return objectOwnerChangedMessageNameRegex;
      } else if (messageName.startsWith(customMessageAcknowledgePrefix)) {
        return customMessageAcknowledgeRegex;
      }
      return null;
    };

    const isMessageAcknowledgement = (messageName: string) => {
      return (
        messageName.startsWith(objectDestroyedMessageNamePrefix) ||
        messageName.startsWith(objectOwnerChangedMessageNamePrefix) ||
        messageName.startsWith(customMessageAcknowledgePrefix)
      );
    };

    export const handleAcknowledgeMessages = () => {
      const p2pMessagesMap = gdjs.evtTools.p2p.getEvents();
      const objectMessageNamesArray = Array.from(p2pMessagesMap.keys());
      // When we receive acknowledgement messages, save it in the extension, to avoid sending the message again.
      const acknowledgedMessageNames = objectMessageNamesArray.filter(
        isMessageAcknowledgement
      );
      acknowledgedMessageNames.forEach((messageName) => {
        if (gdjs.evtTools.p2p.onEvent(messageName, false)) {
          logger.info(`Received acknowledgment for message ${messageName}.`);
          const message = gdjs.evtTools.p2p.getEvent(messageName);
          let data;
          while ((data = message.getData())) {
            const messageSender = message.getSender();
            const regex = getRegexFromAckMessageName(messageName);
            if (!regex) {
              // This should not happen.
              logger.error(`Invalid acknowledgment message ${messageName}.`);
              message.popData();
              return;
            }

            const matches = regex.exec(messageName);
            if (!matches) {
              // This should not happen.
              logger.error(`Invalid acknowledgment message ${messageName}.`);
              message.popData();
              return;
            }
            if (!expectedMessageAcknowledgements[messageName]) {
              // This should not happen, but if we receive an acknowledgment for a message we did not expect, let's not error
              // and just clear that message.
              logger.error(
                `Received acknowledgment for message ${messageName} that was not expected.`
              );
              message.popData();
              return;
            }
            if (!expectedMessageAcknowledgements[messageName][messageSender]) {
              // This should not happen, but if we receive an acknowledgment from a sender we did not expect, let's not error
              // and just clear that message.
              logger.error(
                `Received acknowledgment for message ${messageName} from ${messageSender} that was not expected.`
              );
              message.popData();
              return;
            }

            // If a clock is provided in the message, ensure that we only process the message if the clock is newer than the last one received.
            const messageInstanceClock = data['_clock'];
            if (messageInstanceClock !== undefined) {
              const instanceId = matches[3];
              const lastClock = _lastClockReceivedByInstance[instanceId] || 0;
              if (messageInstanceClock <= lastClock) {
                // Ignore old messages.
                return;
              }
              _lastClockReceivedByInstance[instanceId] = messageInstanceClock;
            }

            logger.info(
              `Marking message ${messageName} as acknowledged from ${messageSender}.`
            );
            // Mark the acknowledgment as received.
            expectedMessageAcknowledgements[messageName][
              messageSender
            ].acknowledged = true;

            // We've received this acknowledgement from this sender, remove it from the list
            // so that the next getSender() will return the next sender.
            message.popData();
          }
        }
      });
    };

    export const resendClearOrCancelAcknowledgedMessages = (
      runtimeScene: gdjs.RuntimeScene
    ) => {
      // When all acknowledgments are received for an message, we can clear the message from our
      // list of expected acknowledgments.
      const expectedMessageNames = Object.keys(expectedMessageAcknowledgements);
      expectedMessageNames.forEach((acknowledgemessageName) => {
        const acknowledgements =
          expectedMessageAcknowledgements[acknowledgemessageName];
        const peerWhoHaventAcknowledged = Object.keys(acknowledgements).filter(
          (peerId) => !acknowledgements[peerId].acknowledged
        );
        if (!peerWhoHaventAcknowledged.length) {
          // All peers have acknowledged this message, we can clear the object.
          logger.info(
            `All peers have acknowledged message ${acknowledgemessageName}.`
          );
          delete expectedMessageAcknowledgements[acknowledgemessageName];
        } else {
          // Some peers have not acknowledged the message, let's resend it to them.
          for (const peerId of peerWhoHaventAcknowledged) {
            const {
              lastMessageSentAt,
              originalMessageName,
              originalData,
              numberOfRetries: currentNumberOfRetries,
              maxNumberOfRetries,
              messageRetryTime,
            } = acknowledgements[peerId];
            if (getTimeNow() - lastMessageSentAt > messageRetryTime) {
              if (currentNumberOfRetries >= maxNumberOfRetries) {
                // We have retried too many times, let's give up.
                logger.info(
                  `Giving up on message ${acknowledgemessageName} for ${peerId}.`
                );
                if (acknowledgements[peerId].shouldCancelMessageIfTimesOut) {
                  // If we should cancel the message if it times out, then revert it based on the original message.
                  if (
                    originalMessageName.startsWith(changeOwnerMessageNamePrefix)
                  ) {
                    const matches =
                      changeOwnerMessageNameRegex.exec(originalMessageName);
                    if (!matches) {
                      // This should not happen, if it does, remove the acknowledgment and return.
                      delete expectedMessageAcknowledgements[
                        acknowledgemessageName
                      ];
                      return;
                    }
                    const objectName = matches[2];
                    const instanceNetworkId = matches[3];
                    const instances = runtimeScene.getInstancesOf(objectName);
                    if (!instances) {
                      // object does not exist in the scene, cannot revert ownership.
                      delete expectedMessageAcknowledgements[
                        acknowledgemessageName
                      ];
                      return;
                    }
                    let instance = instances.find(
                      (instance) => instance.networkId === instanceNetworkId
                    );
                    if (!instance) {
                      // Instance not found, it must have been destroyed already, cannot revert ownership.
                      // Should we recreate it?
                      delete expectedMessageAcknowledgements[
                        acknowledgemessageName
                      ];
                      return;
                    }

                    const behavior = instance.getBehavior(
                      'MultiplayerObject'
                    ) as MultiplayerObjectRuntimeBehavior | null;
                    if (!behavior) {
                      logger.warn(
                        `Object ${objectName} does not have the MultiplayerObjectBehavior, cannot revert ownership.`
                      );
                      // Object does not have the MultiplayerObjectBehavior, cannot revert ownership.
                      delete expectedMessageAcknowledgements[
                        acknowledgemessageName
                      ];
                      return;
                    }

                    const previousOwner = originalData.previousOwner;
                    if (!previousOwner) {
                      // No previous owner, cannot revert ownership.
                      delete expectedMessageAcknowledgements[
                        acknowledgemessageName
                      ];
                      return;
                    }

                    // Force the ownership change.
                    behavior._playerNumber = previousOwner || 0;
                  }
                }
                delete expectedMessageAcknowledgements[acknowledgemessageName];
                continue;
              }

              // We have waited long enough for the acknowledgment, let's resend the message.
              sendDataTo(peerId, originalMessageName, originalData);
              // Reset the timestamp so that we wait again for the acknowledgment.
              acknowledgements[peerId].lastMessageSentAt = getTimeNow();
              // Increment the number of retries.
              acknowledgements[peerId].numberOfRetries =
                currentNumberOfRetries + 1;
            }
          }
        }
      });
    };

    const destroyObjectMessageNamePrefix = '#destroy';
    const destroyObjectMessageNameRegex =
      /#destroy#owner_(\d+)#object_(.+)#instance_(.+)/;
    export const createDestroyObjectMessage = ({
      objectOwner,
      objectName,
      instanceNetworkId,
    }: {
      objectOwner: number;
      objectName: string;
      instanceNetworkId: string;
    }): {
      messageName: string;
      messageData: any;
    } => {
      return {
        messageName: `${destroyObjectMessageNamePrefix}#owner_${objectOwner}#object_${objectName}#instance_${instanceNetworkId}`,
        messageData: {},
      };
    };
    const objectDestroyedMessageNamePrefix = '#destroyed';
    const objectDestroyedMessageNameRegex =
      /#destroyed#owner_(\d+)#object_(.+)#instance_(.+)/;
    export const createObjectDestroyedMessageNameFromDestroyMessage = (
      messageName: string
    ): string => {
      return messageName.replace(
        destroyObjectMessageNamePrefix,
        objectDestroyedMessageNamePrefix
      );
    };
    export const handleDestroyObjectMessages = (
      runtimeScene: gdjs.RuntimeScene
    ) => {
      const p2pMessagesMap = gdjs.evtTools.p2p.getEvents();
      const objectMessageNamesArray = Array.from(p2pMessagesMap.keys());
      const destroyObjectMessageNames = objectMessageNamesArray.filter(
        (messageName) => messageName.startsWith(destroyObjectMessageNamePrefix)
      );
      destroyObjectMessageNames.forEach((messageName) => {
        if (gdjs.evtTools.p2p.onEvent(messageName, false)) {
          const data = JSON.parse(gdjs.evtTools.p2p.getEventData(messageName));
          const messageSender = gdjs.evtTools.p2p.getEventSender(messageName);
          if (data && messageSender) {
            logger.info(`Received message ${messageName} with data ${data}.`);
            const matches = destroyObjectMessageNameRegex.exec(messageName);
            if (!matches) {
              return;
            }
            const playerNumber = parseInt(matches[1], 10);
            if (playerNumber === gdjs.multiplayer.playerPositionInLobby) {
              // Do not destroy the object if we receive an message from ourselves.
              // Should probably never happen.
              return;
            }
            const objectName = matches[2];
            const instanceNetworkId = matches[3];

            const messageInstanceClock = data['_clock'];
            const lastClock =
              _lastClockReceivedByInstance[instanceNetworkId] || 0;
            if (messageInstanceClock <= lastClock) {
              // Ignore old messages.
              logger.info('Ignoring old message.');
              return;
            }

            const instance = getInstanceFromNetworkId({
              runtimeScene,
              objectName,
              instanceNetworkId,
            });

            const destroyedMessageName =
              createObjectDestroyedMessageNameFromDestroyMessage(messageName);

            if (!instance) {
              logger.info(
                'Instance was not found in the scene, sending acknowledgment anyway.'
              );
              // Instance not found, it must have been destroyed already.
              // Send an acknowledgment to the player who sent the destroy message in case they missed it.
              sendDataTo(messageSender, destroyedMessageName, {});
              return;
            }

            logger.info(
              `Destroying object ${objectName} with instance network ID ${instanceNetworkId}.`
            );
            instance.deleteFromScene(runtimeScene);
            _lastClockReceivedByInstance[instanceNetworkId] =
              messageInstanceClock;

            logger.info(
              `Sending acknowledgment of destruction of object ${objectName} with instance network ID ${instanceNetworkId} to ${messageSender}.`
            );
            // Once the object is destroyed, we need to acknowledge it to the player who sent the destroy message.
            sendDataTo(messageSender, destroyedMessageName, {});

            // If we are player number 1, we need to relay the destruction to others.
            // And expect an acknowledgment from everyone else as well.
            if (gdjs.multiplayer.playerPositionInLobby === 1) {
              const connectedPeerIds = gdjs.evtTools.p2p.getAllPeers();
              // We don't need to send the message to the player who sent the destroy message.
              const otherPeerIds = connectedPeerIds.filter(
                (peerId) => peerId !== messageSender
              );
              if (!otherPeerIds.length) {
                // No one else to relay the message to.
                return;
              }

              addExpectedMessageAcknowledgement({
                originalMessageName: messageName,
                originalData: data,
                expectedMessageName: destroyedMessageName,
                otherPeerIds,
              });
              for (const peerId of otherPeerIds) {
                logger.info(
                  `Relaying destruction of object ${objectName} with instance network ID ${instanceNetworkId} to ${peerId}.`
                );
                sendDataTo(peerId, messageName, data);
              }
            }
          }
        }
      });
    };

    const customMessageNamePrefix = '#customMessage';
    const customMessageRegex = /#customMessage#(.+)/;
    const getCustomMessageNameFromUserMessageName = (
      userMessageName: string
    ) => {
      return `${customMessageNamePrefix}#${userMessageName}`;
    };
    const createCustomMessage = ({
      userMessageName,
      userMessageData,
    }: {
      userMessageName: string;
      userMessageData: any;
    }) => {
      const messageId = gdjs.makeUuid();
      return {
        messageName: getCustomMessageNameFromUserMessageName(userMessageName),
        messageData: {
          data: userMessageData,
          uniqueId: messageId,
        },
      };
    };
    const customMessageAcknowledgePrefix = '#ackCustomMessage';
    const customMessageAcknowledgeRegex = /#ackCustomMessage#(.+)/;
    const createAcknowledgeCustomMessageNameFromCustomMessage = (
      messageName: string
    ): string => {
      return messageName.replace(
        customMessageNamePrefix,
        customMessageAcknowledgePrefix
      );
    };

    export const sendMessage = (
      userMessageName: string,
      userMessageData: string
    ) => {
      const connectedPeerIds = gdjs.evtTools.p2p.getAllPeers();
      const { messageName, messageData } = createCustomMessage({
        userMessageName,
        userMessageData,
      });
      const acknowledgmentMessageName =
        createAcknowledgeCustomMessageNameFromCustomMessage(messageName);
      addExpectedMessageAcknowledgement({
        originalMessageName: messageName,
        originalData: messageData,
        expectedMessageName: acknowledgmentMessageName,
        otherPeerIds: connectedPeerIds, // Expect acknowledgment from all peers.
      });
      for (const peerId of connectedPeerIds) {
        sendDataTo(peerId, messageName, messageData);
      }

      // If we are player number 1, we are the server so we can consider this messaged as received
      // and add it to the list of custom messages to process on top of the messages received.
      if (gdjs.multiplayer.playerPositionInLobby === 1) {
        const message = gdjs.evtTools.p2p.getEvent(messageName);
        message.pushData(
          new gdjs.evtTools.p2p.EventData(
            JSON.stringify(messageData),
            gdjs.evtTools.p2p.getCurrentId()
          )
        );
        // The message is now automatically added to the list of messages to process,
        // and will be removed at the end of the frame.
      }
    };

    export const hasMessageBeenReceived = (userMessageName: string) => {
      const messageName =
        getCustomMessageNameFromUserMessageName(userMessageName);
      const messageHasBeenReceived = gdjs.evtTools.p2p.onEvent(
        messageName,
        false
      );
      if (messageHasBeenReceived) {
        const messageData = gdjs.evtTools.p2p.getEventData(messageName);
        const uniqueMessageId = JSON.parse(messageData).uniqueId;
        const customMessageCacheKey = `${messageName}#${uniqueMessageId}`;
        if (processedCustomMessagesCache.has(customMessageCacheKey)) {
          // Message has already been processed recently. This can happen if the message is sent multiple times,
          // after not being acknowledged properly.
          return false;
        }
        processedCustomMessagesCache.add(customMessageCacheKey);
        return true;
      }

      return false;
    };

    export const getMessageData = (messageName: string) => {
      const data = gdjs.evtTools.p2p.getEventData(messageName);
      return data;
    };

    export const handleCustomMessages = (): void => {
      const p2pMessagesMap = gdjs.evtTools.p2p.getEvents();
      const customMessageNamesArray = Array.from(p2pMessagesMap.keys());
      const customMessageNames = customMessageNamesArray.filter((messageName) =>
        messageName.startsWith(customMessageNamePrefix)
      );
      customMessageNames.forEach((messageName) => {
        if (gdjs.evtTools.p2p.onEvent(messageName, false)) {
          const event = gdjs.evtTools.p2p.getEvent(messageName);
          const data = JSON.parse(event.getData());
          const uniqueMessageId = data.uniqueId;
          const messageSender = event.getSender();
          logger.info(`Received message ${messageName} with data ${data}.`);
          const matches = customMessageRegex.exec(messageName);
          if (!matches) {
            // This should not happen.
            logger.error(`Invalid custom message ${messageName}.`);
            return;
          }

          const customMessageCacheKey = `${messageName}#${uniqueMessageId}`;
          if (processedCustomMessagesCache.has(customMessageCacheKey)) {
            // Message has already been processed recently. This can happen if the message is sent multiple times,
            // after not being acknowledged properly.
            logger.info(
              `Message ${messageName} has already been processed, skipping.`
            );
            return;
          }

          logger.info(
            `Received custom message ${messageName} with data ${data}.`
          );

          const acknowledgmentMessageName =
            createAcknowledgeCustomMessageNameFromCustomMessage(messageName);
          logger.info(
            `Sending acknowledgment of custom message ${messageName} to ${messageSender}.`
          );
          sendDataTo(messageSender, acknowledgmentMessageName, {});

          // If we are player number 1, we are the server,
          // so we need to relay the message to others.
          if (gdjs.multiplayer.playerPositionInLobby === 1) {
            // In the case of custom messages, we relay the message to all players, including the sender.
            // This allows the sender to process it the same way others would, when they receive the event.
            const connectedPeerIds = gdjs.evtTools.p2p.getAllPeers();
            if (!connectedPeerIds.length) {
              // No one else to relay the message to.
              return;
            }

            addExpectedMessageAcknowledgement({
              originalMessageName: messageName,
              originalData: data,
              expectedMessageName: acknowledgmentMessageName,
              otherPeerIds: connectedPeerIds,
            });
            for (const peerId of connectedPeerIds) {
              logger.info(
                `Relaying custom message ${messageName} to ${peerId}.`
              );
              sendDataTo(peerId, messageName, data);
            }
          }
        }
      });
    };
  }
}