// @flow
const debug = require('debug')('athena:queue:message-notification');
import processQueue from '../../shared/bull/process-queue';
import createQueue from '../../shared/bull/create-queue';
import { MESSAGE_NOTIFICATION, SEND_NEW_MESSAGE_EMAIL } from './constants';
import { fetchPayload, createPayload } from '../utils/payloads';
import { getDistinctActors } from '../utils/actors';
import {
  storeNotification,
  updateNotification,
  checkForExistingNotification,
} from '../models/notification';
import {
  storeUsersNotifications,
  markUsersNotificationsAsNew,
} from '../models/usersNotifications';
import { getThreadNotificationUsers } from '../models/usersThreads';
import {
  getDirectMessageThreadMembers,
} from '../models/usersDirectMessageThreads';

const sendNewMessageEmailQueue = createQueue(SEND_NEW_MESSAGE_EMAIL);

const addToSendNewMessageEmailQueue = (recipient, thread, user, message) => {
  if (!recipient || !recipient.email || !thread || !user || !message) {
    debug('aborting adding to email queue due to invalid data');
    return Promise.resolve();
  }

  return sendNewMessageEmailQueue.add({
    to: recipient.email,
    user: {
      displayName: recipient.name,
      username: recipient.username,
    },
    threads: [
      {
        // TODO: Figure out what to do as the title in DMs
        title: thread.content.title,
        id: thread.id,
        replies: [
          {
            sender: {
              name: user.name,
              profilePhoto: user.profilePhoto,
            },
            content: {
              body: message.content.body,
            },
          },
        ],
      },
    ],
  });
};

const processMessageNotificationQueue = job => {
  const incomingMessage = job.data.message;
  const currentUserId = job.data.userId;

  // Determine what the context type should be based on the message that was sent
  const contextType = incomingMessage.threadType === 'directMessageThread'
    ? 'DIRECT_MESSAGE_THREAD'
    : 'THREAD';

  debug(
    `new job: message sent by ${currentUserId} in ${contextType
      .toLowerCase()
      .replace('_', ' ')}#${incomingMessage.threadId}`
  );

  /*
    These promises are used to create or modify a notification. The order is:
    - actor
    - context
    - entity
  */
  const getPayloads = [
    // Check to see if an existing notif exists by matching the 'event' type, with the context of the notification, within a certain time period.
    checkForExistingNotification('MESSAGE_CREATED', incomingMessage.threadId),
    //get the user who left the message
    fetchPayload('USER', incomingMessage.senderId),
    // get the thread the message was left in - could be a dm or story depending on the contextType
    fetchPayload(contextType, incomingMessage.threadId),
    // create an entity payload with the message that was sent
    createPayload('MESSAGE', incomingMessage),
  ];

  return Promise.all(getPayloads)
    .then(([existing, actor, context, entity]) => {
      debug(`payloads loaded, generating notification data`);
      // Calculate actors
      const previousActors = existing ? existing.actors : [];
      const actors = getDistinctActors([...previousActors, actor]);

      // Calculate entities
      const previousEntities = existing ? existing.entities : [];
      const entities = [...previousEntities, entity];

      // Create notification
      const newNotification = Object.assign({}, existing || {}, {
        actors: actors,
        event: 'MESSAGE_CREATED',
        context,
        entities: entities,
      });

      debug(
        existing
          ? 'updating exisiting notification'
          : 'creating new notification'
      );
      const notificationPromise = existing
        ? updateNotification(newNotification)
        : storeNotification(newNotification);

      return (
        notificationPromise
          // Do the .then here so we keep the loaded data in scope
          .then(notification => {
            const getRecipients = contextType === 'DIRECT_MESSAGE_THREAD'
              ? getDirectMessageThreadMembers(notification.context.id)
              : getThreadNotificationUsers(notification.context.id);

            debug('get recipients for notification');
            return Promise.all([notification, getRecipients]);
          })
          .then(([notification, recipients]) => {
            // filter out the user who sent the message, as they should not recieve a notification for their own messages
            const filteredRecipients = recipients.filter(
              recipient => recipient.userId !== currentUserId
            );

            debug(
              (existing
                ? 'mark existing usersnotifications as new'
                : 'store new usersnotifications records') +
                ' and add notification emails to queue for all recipients'
            );
            const thread = JSON.parse(context.payload);
            const message = JSON.parse(entity.payload);
            const user = JSON.parse(actor.payload);
            const dbMethod = existing
              ? markUsersNotificationsAsNew
              : storeUsersNotifications;
            return Promise.all(
              filteredRecipients.map(recipient => {
                addToSendNewMessageEmailQueue(recipient, thread, user, message);
                return dbMethod(notification.id, recipient.userId);
              })
            );
          })
      );
    })
    .catch(err => {
      console.log(err);
    });
};

export default () =>
  processQueue(MESSAGE_NOTIFICATION, processMessageNotificationQueue);
