/* eslint-disable @typescript-eslint/no-require-imports */
/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-unused-vars */
import { Injectable } from '@nestjs/common';
import { ChannelMessage, EButtonMessageStyle, Events } from 'mezon-sdk';
import { BaseHandleEvent } from './base.handle';
import { MezonClientService } from 'src/mezon/services/client.service';
import {
  EmbedProps, EMessageComponentType,
  EMessageMode, EPMRequestAbsenceDay, ERequestAbsenceDateType,
  ERequestAbsenceDayStatus,
  ERequestAbsenceDayType, ERequestAbsenceType,
  EUnlockTimeSheet,
  EUnlockTimeSheetPayment,
  FFmpegImagePath,
  FileType,
  MEZON_EMBED_FOOTER,
} from '../constants/configs';
import { MessageQueue } from '../services/messageQueue.service';
import {
  Daily,
  Quiz,
  UnlockTimeSheet,
  User,
  UserQuiz,
  W2Request,
} from '../models';
import { AbsenceDayRequest } from '../models';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ReplyMezonMessage } from '../asterisk-commands/dto/replyMessage.dto';
import {
  changeDateFormat,
  checkAnswerFormat,
  createReplyMessage,
  generateEmail,
  generateQRCode,
  getRandomColor,
  getUserNameByEmail,
  getWeekDays,
  sleep,
} from '../utils/helper';
import { QuizService } from '../services/quiz.services';
import { refGenerate } from '../utils/generateReplyMessage';
import { MusicService } from '../services/music.services';
import { FFmpegService } from '../services/ffmpeg.service';
import { ChannelDMMezon } from '../models/channelDmMezon.entity';
import { TimeSheetService } from '../services/timesheet.services';
import {
  checkTimeNotWFH,
  checkTimeSheet,
} from '../asterisk-commands/commands/daily/daily.functions';
import { AxiosClientService } from '../services/axiosClient.services';
import { ClientConfigService } from '../config/client-config.service';
import {
  handleBodyRequestAbsenceDay,
  validateAbsenceTime,
  validateAbsenceTypeDay,
  validateAndFormatDate,
  validateHourAbsenceDay,
  validateTypeAbsenceDay,
  validReasonAbsenceDay,
} from '../utils/request-helper';
import { OnEvent } from '@nestjs/event-emitter';
const https = require('https');
import axios from 'axios';

@Injectable()
export class MessageButtonClickedEvent extends BaseHandleEvent {
  constructor(
    clientService: MezonClientService,
    private messageQueue: MessageQueue,
    @InjectRepository(User) private userRepository: Repository<User>,
    @InjectRepository(UserQuiz)
    private userQuizRepository: Repository<UserQuiz>,
    @InjectRepository(Quiz)
    private quizRepository: Repository<Quiz>,
    private quizService: QuizService,
    @InjectRepository(UnlockTimeSheet)
    private unlockTimeSheetRepository: Repository<UnlockTimeSheet>,
    private musicService: MusicService,
    private ffmpegService: FFmpegService,
    @InjectRepository(ChannelDMMezon)
    private channelDmMezonRepository: Repository<ChannelDMMezon>,

    private timeSheetService: TimeSheetService,
    @InjectRepository(User)
    private dailyRepository: Repository<Daily>,
    @InjectRepository(AbsenceDayRequest)
    private absenceDayRequestRepository: Repository<AbsenceDayRequest>,
    private axiosClientService: AxiosClientService,
    private clientConfigService: ClientConfigService,
    @InjectRepository(W2Request)
    private w2RequestsRepository: Repository<W2Request>,
  ) {
    super(clientService);
  }

  @OnEvent(Events.MessageButtonClicked)
  async hanndleButtonForm(data) {
    const args = data.button_id.split('_');
    // check case by buttonId
    const buttonConfirmType = args[0];
    switch (buttonConfirmType) {
      case 'question':
        this.handleAnswerQuestionWFH(data);
        break;
      case 'music':
        this.handleMusicEvent(data);
        break;
      case 'unlockTs':
        this.handleUnlockTimesheet(data);
        break;
      case ERequestAbsenceDayType.REMOTE:
      case ERequestAbsenceDayType.ONSITE:
      case ERequestAbsenceDayType.OFF:
      case ERequestAbsenceDayType.OFFCUSTOM:
        this.handleRequestAbsenceDay(data);
        break;
      case 'daily':
        this.handleSubmitDaily(data);
        break;
      case 'logts':
        this.handleLogTimesheet(data);
        break;
      case 'w2request':
        this.handleEventRequestW2(data);
        break;
      case 'PMRequestDay':
        this.handlePMRequestAbsenceDay(data);
        break;
      default:
        break;
    }
  }

  async handleAnswerQuestionWFH(data) {
    try {
      const args = data.button_id.split('_');
      if (args[0] !== 'question') return;
      const answer = args[1];
      const channelDmId = args[2];
      await this.userRepository.update(
        { userId: data.user_id },
        {
          botPing: false,
        },
      );
      const userQuiz = await this.userQuizRepository
        .createQueryBuilder()
        .where('"channel_id" = :channel_id', {
          channel_id: channelDmId,
        })
        .andWhere('"message_id" = :mess_id', {
          mess_id: data.message_id,
        })
        .select('*')
        .getRawOne();
      let mess = '';
      const messOptions = {};
      if (userQuiz['answer']) {
        mess = `Bạn đã trả lời câu hỏi này rồi`;
      } else {
        const question = await this.quizRepository
          .createQueryBuilder()
          .where('id = :quizId', { quizId: userQuiz['quizId'] })
          .select('*')
          .getRawOne();
        if (question) {
          if (!checkAnswerFormat(answer, question['options'].length)) {
            mess = `Bạn vui lòng trả lời đúng số thứ tự các đáp án câu hỏi`;
          } else {
            const correctAnser = Number(answer) === Number(question['correct']);
            if (correctAnser) {
              const newUser = await this.quizService.addScores(
                userQuiz['userId'],
              );
              if (!newUser) return;
              mess = `Correct!!!, you have ${newUser[0].scores_quiz} points`;
              await this.quizService.saveQuestionCorrect(
                userQuiz['userId'],
                userQuiz['quizId'],
                Number(answer),
              );
            } else {
              mess = `Incorrect!!!, The correct answer is ${question['correct']}`;
              await this.quizService.saveQuestionInCorrect(
                userQuiz['userId'],
                userQuiz['quizId'],
                Number(answer),
              );
            }

            const link = `https://quiz.nccsoft.vn/question/update/${userQuiz['quizId']}`;
            messOptions['embed'] = [
              {
                color: `${correctAnser ? '#1E9F2E' : '#ff0101'}`,
                title: `${mess}`,
              },
              {
                color: `${'#ff0101'}`,
                title: `Complain`,
                url: link,
              },
            ];
          }
        }
      }
      const KOMU = await this.userRepository.findOne({
        where: { userId: process.env.BOT_KOMU_ID },
      });
      const msg: ChannelMessage = {
        message_id: data.message_id,
        id: '',
        channel_id: channelDmId,
        channel_label: '',
        code: EMessageMode.DM_MESSAGE,
        create_time: '',
        sender_id: process.env.BOT_KOMU_ID,
        username: KOMU.username || 'KOMU',
        avatar: KOMU.avatar,
        content: { t: '' },
        attachments: [{}],
      };
      const messageToUser: ReplyMezonMessage = {
        userId: data.user_id,
        textContent: userQuiz['answer'] ? mess : '',
        messOptions: messOptions,
        attachments: [],
        refs: refGenerate(msg),
      };
      this.messageQueue.addMessage(messageToUser);
    } catch (error) {
      console.log('handleMessageButtonClicked', error);
    }
  }

  async handleMusicEvent(data) {
    const args = data.button_id.split('_');
    if (args[0] != 'music') {
      return;
    }

    if (args[1] == 'search') {
      const KOMU = await this.userRepository.findOne({
        where: { userId: data.sender_id },
      });
      const msg: ChannelMessage = {
        message_id: data.message_id,
        clan_id: process.env.KOMUBOTREST_CLAN_NCC_ID,
        mode: +args[6],
        is_public: Boolean(+args[5]),
        id: '',
        channel_id: data.channel_id,
        channel_label: '',
        code: EMessageMode.CHANNEL_MESSAGE,
        create_time: '',
        sender_id: data.sender_id,
        username: KOMU?.username || 'KOMU',
        avatar: KOMU?.avatar,
        content: { t: '' },
        attachments: [{}],
      };
      const replyMessage = await this.musicService.getMusicListMessage(
        msg,
        args[2],
        args[3],
        args[4],
      );

      if (replyMessage) {
        const replyMessageArray = Array.isArray(replyMessage)
          ? replyMessage
          : [replyMessage];
        for (const mess of replyMessageArray) {
          this.messageQueue.addMessage({ ...mess, sender_id: msg.sender_id }); // add to queue, send every 0.2s
        }
      }
    } else if (args[1] == 'play') {
      const mp3Link = await this.musicService.getMp3Link(args[2]);
      this.ffmpegService.killCurrentStream(FileType.MUSIC);
      await sleep(1000);
      const channel = await this.client.registerStreamingChannel({
        clan_id: process.env.KOMUBOTREST_CLAN_NCC_ID,
        channel_id: process.env.MEZON_MUSIC_CHANNEL_ID,
      });
      if (!channel) return;
      if (channel?.streaming_url !== '') {
        this.ffmpegService
          .transcodeMp3ToRtmp(
            FFmpegImagePath.NCC8,
            mp3Link,
            channel?.streaming_url,
            FileType.MUSIC,
          )
          .catch((error) => console.log('error mp3', error));
      }
    }
  }

  async handleUnlockTimesheet(data) {
    try {
      const args = data.button_id.split('_');
      const findUnlockTsData = await this.unlockTimeSheetRepository.findOne({
        where: { messageId: data.message_id },
      });
      if (args[0] !== 'unlockTs' || !data?.extra_data || !findUnlockTsData)
        return;
      if (findUnlockTsData.userId !== data.user_id) return; // check auth
      const typeButtonRes = args[1]; // (confirm or cancel)
      const dataParse = JSON.parse(data.extra_data);
      const value = dataParse?.RADIO?.split('_')[1]; // (pm or staff)
      //init reply message
      const replyMessage: ReplyMezonMessage = {
        clan_id: findUnlockTsData.clanId,
        channel_id: findUnlockTsData.channelId,
        is_public: findUnlockTsData.isChannelPublic,
        mode: findUnlockTsData.modeMessage,
        msg: {
          t: '',
        },
      };

      // only process with no status (not confirm or cancel request yet)
      if (!findUnlockTsData.status) {
        // check user press button confirm or cancel
        switch (typeButtonRes) {
          case EUnlockTimeSheet.CONFIRM:
            // data for QR code
            const sendTokenData = {
              sender_id: data.user_id,
              receiver_id: process.env.BOT_KOMU_ID,
              receiver_name: 'KOMU',
              amount:
                value === EUnlockTimeSheet.PM
                  ? EUnlockTimeSheetPayment.PM_PAYMENT
                  : EUnlockTimeSheetPayment.STAFF_PAYMENT, // check pm or staff to get payment value
              note: `[UNLOCKTS - ${findUnlockTsData.id}]`,
            };
            // update status active
            await this.unlockTimeSheetRepository.update(
              { id: findUnlockTsData.id },
              {
                amount: sendTokenData.amount,
                status: EUnlockTimeSheet.CONFIRM,
              },
            );

            // gen QR code
            const qrCodeImage = await generateQRCode(
              JSON.stringify(sendTokenData),
            );
            //
            const channelDM = await this.channelDmMezonRepository.findOne({
              where: { user_id: findUnlockTsData.userId },
            });

            // send QR code to user
            const embed: EmbedProps[] = [
              {
                color: getRandomColor(),
                title: `Click HERE`,
                url: `https://mezon.ai/chat/direct/message/${channelDM?.channel_id}/3?openPopup=true&token=${sendTokenData.amount}&userId=${sendTokenData.receiver_id}&note=${sendTokenData.note}`,
                fields: [
                  {
                    name: 'Or scan this QR code for UNLOCK TIMESHEET!',
                    value: '',
                  },
                ],
                image: {
                  url: qrCodeImage + '',
                },
                timestamp: new Date().toISOString(),
                footer: MEZON_EMBED_FOOTER,
              },
            ];
            const messageToUser: ReplyMezonMessage = {
              userId: data.user_id,
              textContent: '',
              messOptions: { embed },
            };
            this.messageQueue.addMessage(messageToUser);
            replyMessage['msg'] = {
              t: 'KOMU was sent to you a message, please check!',
            };
            break;
          default:
            replyMessage['msg'] = {
              t: 'Cancel unlock timesheet successful!',
            };
            // update status active
            await this.unlockTimeSheetRepository.update(
              { id: findUnlockTsData.id },
              {
                status: EUnlockTimeSheet.CANCEL,
              },
            );
            break;
        }
      } else {
        replyMessage['msg'] = {
          t: `This request has been ${findUnlockTsData.status.toLowerCase()}ed!`,
        };
      }

      // generate ref bot message
      const KOMU = await this.userRepository.findOne({
        where: { userId: process.env.BOT_KOMU_ID },
      });
      const msg: ChannelMessage = {
        message_id: data.message_id,
        id: '',
        channel_id: findUnlockTsData.channelId,
        channel_label: '',
        code: findUnlockTsData.modeMessage,
        create_time: '',
        sender_id: process.env.BOT_KOMU_ID,
        username: KOMU.username || 'KOMU',
        avatar: KOMU.avatar,
        content: { t: '' },
        attachments: [{}],
      };
      replyMessage['ref'] = refGenerate(msg);
      //send message
      this.messageQueue.addMessage(replyMessage);
    } catch (e) {
      console.log('handleUnlockTimesheet', e);
    }
  }
  async handleSubmitDaily(data) {
    const senderId = data.user_id;
    const botId = data.sender_id;
    const channelId = data.channel_id;
    const splitButtonId = data.button_id.split('_');
    const messid = splitButtonId[1];
    const clanIdValue = splitButtonId[2];
    const modeValue = splitButtonId[3];
    const codeMessValue = splitButtonId[4];
    const isPublicValue = splitButtonId[5] === 'false' ? false : true;
    const ownerSenderDaily = splitButtonId[6];
    const dateValue = splitButtonId[7];
    const buttonType = splitButtonId[8];
    const invalidLength =
      '```Please enter at least 100 characters in your daily text```';
    const missingField =
      '```Missing project, yesterday, today, or block field```';

    const isOwner = ownerSenderDaily === senderId;
    //init reply message
    const getBotInformation = await this.userRepository.findOne({
      where: { userId: botId },
    });

    const msg: ChannelMessage = {
      message_id: data.message_id,
      id: '',
      channel_id: channelId,
      channel_label: '',
      code: codeMessValue,
      create_time: '',
      sender_id: botId,
      username: getBotInformation.username,
      avatar: getBotInformation.avatar,
      content: { t: '' },
      attachments: [{}],
    };

    const isCancel = buttonType === EUnlockTimeSheet.CANCEL.toLowerCase();
    const isSubmit = buttonType === EUnlockTimeSheet.SUBMIT.toLowerCase();
    try {
      if (!data.extra_data) {
        if (
          (!isOwner && (isCancel || isSubmit)) ||
          (isOwner && (isCancel || isSubmit))
        ) {
          return;
        }
      }
      switch (buttonType) {
        case EUnlockTimeSheet.SUBMIT.toLowerCase():
          let parsedExtraData;
          try {
            parsedExtraData = JSON.parse(data.extra_data);
          } catch (error) {
            throw new Error('Invalid JSON in extra_data');
          }

          const projectKey = `daily-${messid}-project`;
          const yesterdayKey = `daily-${messid}-yesterday-ip`;
          const todayKey = `daily-${messid}-today-ip`;
          const blockKey = `daily-${messid}-block-ip`;
          const workingTimeKey = `daily-${messid}-working-time`;
          const typeOfWorkKey = `daily-${messid}-type-of-work`;
          const taskKey = `daily-${messid}-task`;

          const projectCode = parsedExtraData[projectKey]?.[0];
          const yesterdayValue = parsedExtraData[yesterdayKey];
          const todayValue = parsedExtraData[todayKey];
          const blockValue = parsedExtraData[blockKey];
          const workingTimeValue = parsedExtraData[workingTimeKey];
          const typeOfWorkValue = parsedExtraData[typeOfWorkKey]?.[0];
          const taskValue = parsedExtraData[taskKey]?.[0];

          const isMissingField =
            !projectCode || !yesterdayValue || !todayValue || !blockValue;
          const contentGenerated = `*daily ${projectCode} ${dateValue}\n yesterday:${yesterdayValue}\n today:${todayValue}\n block:${blockValue}`;
          const contentLength =
            yesterdayValue?.length + todayValue?.length + blockValue?.length;

          if (!isOwner) {
            return;
          }
          if (contentLength < 80) {
            const replyMessageInvalidLength = createReplyMessage(
              invalidLength,
              clanIdValue,
              channelId,
              isPublicValue,
              modeValue,
              msg,
            );
            return this.messageQueue.addMessage(replyMessageInvalidLength);
          }
          if (isMissingField) {
            const replyMessageMissingField = createReplyMessage(
              missingField,
              clanIdValue,
              channelId,
              isPublicValue,
              modeValue,
              msg,
            );
            return this.messageQueue.addMessage(replyMessageMissingField);
          }
          const findUser = await this.userRepository
            .createQueryBuilder()
            .where(`"userId" = :userId`, { userId: senderId })
            .andWhere(`"deactive" IS NOT true`)
            .select('*')
            .getRawOne();

          if (!findUser) return;

          const authorUsername = findUser.email;
          const emailAddress = generateEmail(authorUsername);

          const wfhResult = await this.timeSheetService.findWFHUser();
          const wfhUserEmail = wfhResult.map((item) =>
            getUserNameByEmail(item.emailAddress),
          );

          await this.saveDaily(
            senderId,
            channelId,
            contentGenerated as string,
            authorUsername,
          );

          await this.timeSheetService.logTimeSheetForTask(
            todayValue,
            emailAddress,
            projectCode,
            typeOfWorkValue,
            taskValue,
            workingTimeValue,
          );
          const isValidTimeFrame = checkTimeSheet();
          const isValidWFH = checkTimeNotWFH();
          const baseMessage = '✅ Daily saved.';
          const errorMessageWFH =
            '✅ Daily saved. (Invalid daily time frame. Please daily at 7h30-9h30, 12h-17h. WFH not daily 20k/time.)';
          const errorMessageNotWFH =
            '✅ Daily saved. (Invalid daily time frame. Please daily at 7h30-17h. not daily 20k/time.)';

          const messageContent = wfhUserEmail.includes(authorUsername)
            ? isValidTimeFrame
              ? baseMessage
              : errorMessageWFH
            : isValidWFH
              ? baseMessage
              : errorMessageNotWFH;
          const replyMessageSubmit = createReplyMessage(
            messageContent,
            clanIdValue,
            channelId,
            isPublicValue,
            modeValue,
            msg,
          );
          const textDailySuccess =
            '```' +
            messageContent +
            '\n' +
            `Date: ${dateValue}` +
            '\n' +
            `Yesterday: ${yesterdayValue}` +
            '\n' +
            `Today: ${todayValue}` +
            '\n' +
            `Block: ${blockValue}` +
            '\n' +
            `Working time: ${workingTimeValue}h` +
            '```';
          const msgDailySuccess = {
            t: textDailySuccess,
            mk: [{ type: 't', s: 0, e: textDailySuccess.length }],
          };
          await this.client.updateChatMessage(
            clanIdValue,
            channelId,
            modeValue,
            isPublicValue,
            data.message_id,
            msgDailySuccess,
          );
          // this.messageQueue.addMessage(replyMessageSubmit);
          break;
        case EUnlockTimeSheet.CANCEL.toLowerCase():
          return;
        default:
          break;
      }
    } catch (error) {
      console.error('Error in handleSubmitDaily:', error.message);
    }
  }

  saveDaily(senderId: string, channelId: string, args: string, email: string) {
    return this.dailyRepository
      .createQueryBuilder()
      .insert()
      .into(Daily)
      .values({
        userid: senderId,
        email: email,
        daily: args,
        createdAt: Date.now(),
        channelid: channelId,
      })
      .execute();
  }
  async handleRequestAbsenceDay(data) {
    const senderId = data.user_id;
    const botId = data.sender_id;
    const channelId = data.channel_id;
    const splitButtonId = data.button_id.split('_');
    const messid = splitButtonId[1];
    const clanIdValue = splitButtonId[2];
    const modeValue = splitButtonId[3];
    const codeMessValue = splitButtonId[4];
    const isPublicValue = splitButtonId[5] === 'false' ? false : true;
    const typeButtonRes = splitButtonId[6]; // (confirm or cancel)

    //init reply message
    const getBotInformation = await this.userRepository.findOne({
      where: { userId: botId },
    });

    const msg: ChannelMessage = {
      message_id: data.message_id,
      id: '',
      channel_id: channelId,
      channel_label: '',
      code: codeMessValue,
      create_time: '',
      sender_id: botId,
      username: getBotInformation.username,
      avatar: getBotInformation.avatar,
      content: { t: '' },
      attachments: [{}],
    };

    try {
      // Parse button_id
      const args = data.button_id.split('_');
      const typeRequest = args[0];
      const typeRequestDayEnum = ERequestAbsenceDayType[typeRequest as keyof typeof ERequestAbsenceDayType];
      if (!data?.extra_data) return;
      // Find absence data
      const findAbsenceData = await this.absenceDayRequestRepository.findOne({
        where: { messageId: data.message_id },
      });
      if (!findAbsenceData) return;

      // Check user authorization
      if (findAbsenceData.userId !== data.user_id) return;

      const dataParse = JSON.parse(data.extra_data);

      // Initialize reply message
      const replyMessage: ReplyMezonMessage = {
        clan_id: findAbsenceData.clanId,
        channel_id: findAbsenceData.channelId,
        is_public: findAbsenceData.isChannelPublic,
        mode: findAbsenceData.modeMessage,
        msg: {
          t: '',
        },
      };
      // find emailAddress by senderId
      const findUser = await this.userRepository
        .createQueryBuilder()
        .where(`"userId" = :userId`, { userId: findAbsenceData.userId })
        .andWhere(`"deactive" IS NOT true`)
        .select('*')
        .getRawOne();
      if (!findUser) return;
      const authorUsername = findUser.email;
      const emailAddress = generateEmail(authorUsername);

      // Process only requests without status
      if (!findAbsenceData.status) {
        switch (typeButtonRes) {
          case ERequestAbsenceDayStatus.CONFIRM:
            // Valid input and format
            const validDate = validateAndFormatDate(dataParse.dateAt);
            const validHour = validateHourAbsenceDay(
              dataParse.hour || '0',
              typeRequestDayEnum,
            );
            const validTypeDate = validateTypeAbsenceDay(
              dataParse.dateType ? dataParse.dateType[0] : null,
              typeRequestDayEnum,
            );
            const validReason = validReasonAbsenceDay(
              dataParse.reason,
              typeRequestDayEnum,
            );
            const validAbsenceType = validateAbsenceTypeDay(
              dataParse.absenceType ? dataParse.absenceType[0] : null,
              typeRequestDayEnum,
            );
            const validAbsenceTime = validateAbsenceTime(
              dataParse.absenceTime ? dataParse.absenceTime[0] : null,
              typeRequestDayEnum,
            );
            const userId = findAbsenceData.userId;
            const validations = [
              { valid: validDate.valid, message: validDate.message },
              {
                valid: validAbsenceTime.valid,
                message: validAbsenceTime.message,
              },
              { valid: validHour.valid, message: validHour.message },
              { valid: validTypeDate.valid, message: validTypeDate.message },
              {
                valid: validAbsenceType.valid,
                message: validAbsenceType.message,
              },
              { valid: validReason.valid, message: validReason.message },
            ];
            for (const { valid, message } of validations) {
              if (!valid) {
                const replyMessageInvalidLength = createReplyMessage(
                  `\`\`\`❌ ${message || 'Invalid input'}\`\`\``,
                  clanIdValue,
                  channelId,
                  isPublicValue,
                  modeValue,
                  msg,
                );
                this.messageQueue.addMessage(replyMessageInvalidLength);
                return;
              }
            }

            dataParse.dateAt = validDate?.formattedDate;
            const body = handleBodyRequestAbsenceDay(
              dataParse,
              typeRequest,
              emailAddress,
            );
            let requestId = 0;
            try {
              // Call API request absence day
              const resAbsenceDayRequest =
                await this.timeSheetService.requestAbsenceDay(body);
              if (resAbsenceDayRequest?.data?.success) {
                const replyMessageInvalidLength = createReplyMessage(
                  `\`\`\`✅ Request ${typeRequest || 'absence'} successful! \`\`\``,
                  clanIdValue,
                  channelId,
                  isPublicValue,
                  modeValue,
                  msg,
                );
                requestId = resAbsenceDayRequest.data.result.absences[0].requestId;
                this.messageQueue.addMessage(replyMessageInvalidLength);
              } else {
                throw new Error('Request failed!');
              }
            } catch (error) {
              const replyMessageInvalidLength = createReplyMessage(
                `\`\`\`❌ ${error.response.data.error.message || 'Request absence failed.'}\`\`\``,
                clanIdValue,
                channelId,
                isPublicValue,
                modeValue,
                msg,
              );
              this.messageQueue.addMessage(replyMessageInvalidLength);
              return;
            }
            // Update status to CONFIRM
            await this.absenceDayRequestRepository.update(
              { id: findAbsenceData.id },
              {
                status: ERequestAbsenceDayStatus.CONFIRM,
                reason: body.reason,
                dateType: body.absences[0].dateType,
                absenceTime: body.absences[0].absenceTime,
                requestId: requestId,
              },
            );
            // Send notification to PMs of user
            const dataPms = await this.timeSheetService.getPMsOfUser(emailAddress);
            if(dataPms?.data?.success){
              const resultPms = dataPms.data.result;
              const emails = resultPms
                .filter(project => project.projectName !== "Company Activities")
                .flatMap(project =>
                  project.pMs.map(pm => pm.emailAddress)
                )
                .filter(email => email !== null);

              const usernames = emails.map(email => email.split('@')[0]);
              const users = await this.userRepository.find({
                where: usernames.map((username) => ({
                  username,
                  deactive: false,
                })),
                select: ['userId'],
              });

              const userIdPms = users.map((user) => user.userId);
              const usernameSender = emailAddress.split('@')[0];
              let dateType = ERequestAbsenceDateType[body.absences[0].dateType];
              if (dateType === ERequestAbsenceDateType[4]) {
                dateType = 'Đi muộn/ Về sớm';
              }
              for (const userIdPm of userIdPms) {
                const embedSendMessageToPm: EmbedProps[] = [
                  {
                    color: '#57F287',
                    title: `${usernameSender} has sent a request ${typeRequest} for following dates: ${body.absences[0].dateAt} ${dateType}`,
                  },
                ];
                const componentsSendPm = [
                  {
                    components: [
                      {
                        id: `PMRequestDay_REJECT_${requestId}_${usernameSender}_${typeRequest}_${body.absences[0].dateAt}_${dateType}`,
                        type: EMessageComponentType.BUTTON,
                        component: {
                          label: `Reject`,
                          style: EButtonMessageStyle.DANGER,
                        },
                      },
                      {
                        id: `PMRequestDay_APPROVE_${requestId}_${usernameSender}_${typeRequest}_${body.absences[0].dateAt}_${dateType}`,
                        type: EMessageComponentType.BUTTON,
                        component: {
                          label: `Approve`,
                          style: EButtonMessageStyle.SUCCESS,
                        },
                      },
                    ],
                  },
                ];
                const messageToUser: ReplyMezonMessage = {
                  userId: userIdPm,
                  textContent: '',
                  messOptions: {
                    embed: embedSendMessageToPm,
                    components: componentsSendPm,
                  },
                };
                this.messageQueue.addMessage(messageToUser);
              }
            }
            break;
          default:
            const replyMessageInvalidLength = createReplyMessage(
              `\`\`\`Cancel request ${typeRequest || 'absence'} successful! \`\`\``,
              clanIdValue,
              channelId,
              isPublicValue,
              modeValue,
              msg,
            );
            this.messageQueue.addMessage(replyMessageInvalidLength);
            // Update status to CANCEL
            await this.absenceDayRequestRepository.update(
              { id: findAbsenceData.id },
              { status: ERequestAbsenceDayStatus.CANCEL },
            );
            break;
        }
      } else {
        replyMessage['msg'] = {
          t: `This request has been ${findAbsenceData.status}ed!`,
        };
      }
    } catch (e) {
      console.error('handleRequestAbsence', e);
    }
  }
  async handleLogTimesheet(data) {
    const senderId = data.user_id;
    const botId = data.sender_id;
    const channelId = data.channel_id;
    const splitButtonId = data.button_id.split('_');
    const messid = splitButtonId[1];
    const clanIdValue = splitButtonId[2];
    const modeValue = splitButtonId[3];
    const codeMessValue = splitButtonId[4];
    const isPublicValue = splitButtonId[5] === 'false' ? false : true;
    const ownerSenderId = splitButtonId[6];
    const ownerSenderEmail = splitButtonId[7];
    const isLogByWeek = splitButtonId[8] === 'false' ? false : true;
    const buttonType = splitButtonId[9];
    const isOwner = ownerSenderId === senderId;
    const missingFieldMessage = '```Missing some field```';
    const logTimesheetByDateSuccess = '```Timesheet Logged Successfully on```';
    const logTimesheetByWeekSuccess =
      '```Timesheet Logged Successfully for the Week```';
    const logTimesheetByDateFail = '```Failed to Log Timesheet```';

    //init reply message
    const getBotInformation = await this.userRepository.findOne({
      where: { userId: botId },
    });

    const msg: ChannelMessage = {
      message_id: data.message_id,
      id: '',
      channel_id: channelId,
      channel_label: '',
      code: codeMessValue,
      create_time: '',
      sender_id: botId,
      username: getBotInformation.username,
      avatar: getBotInformation.avatar,
      content: { t: '' },
      attachments: [{}],
    };

    const isCancel = buttonType === EUnlockTimeSheet.CANCEL.toLowerCase();
    const isSubmit = buttonType === EUnlockTimeSheet.SUBMIT.toLowerCase();
    try {
      if (!data.extra_data) {
        if (
          (!isOwner && (isCancel || isSubmit)) ||
          (isOwner && (isCancel || isSubmit))
        ) {
          return;
        }
      }
      switch (buttonType) {
        case EUnlockTimeSheet.SUBMIT.toLowerCase():
          let parsedExtraData;
          try {
            parsedExtraData = JSON.parse(data.extra_data);
          } catch (error) {
            throw new Error('Invalid JSON in extra_data');
          }
          const dateKey = `logts-${messid}-date`;
          const projectKey = `logts-${messid}-project`;
          const taskKey = `logts-${messid}-task`;
          const noteKey = `logts-${messid}-note`;
          const workingTimeKey = `logts-${messid}-working-time`;
          const typeOfWorkKey = `logts-${messid}-type-of-work`;

          const dateValue = parsedExtraData[dateKey];
          const projectId = parsedExtraData[projectKey]?.[0];
          const taskValue = parsedExtraData[taskKey]?.[0];
          const noteValue = parsedExtraData[noteKey];
          const workingTimeValue = parsedExtraData[workingTimeKey] * 60;
          const typeOfWorkValue = parsedExtraData[typeOfWorkKey]?.[0];

          const isMissingField =
            (!isLogByWeek && !dateValue) ||
            !projectId ||
            !taskValue ||
            !noteValue ||
            !workingTimeValue;

          if (!isOwner) {
            return;
          }

          if (isMissingField) {
            const replyMessageMissingField = createReplyMessage(
              missingFieldMessage,
              clanIdValue,
              channelId,
              isPublicValue,
              modeValue,
              msg,
            );
            return this.messageQueue.addMessage(replyMessageMissingField);
          }

          if (isLogByWeek) {
            const today = new Date();
            const daysOfWeek = getWeekDays(today);
            const mapToPayloadOfWeek = daysOfWeek.map((day) => ({
              dateAt: day,
              projectTaskId: taskValue,
              workingTime: workingTimeValue,
              typeOfWork: typeOfWorkValue,
              note: noteValue,
              emailAddress: ownerSenderEmail,
            }));
            await this.timeSheetService.logTimeSheetByWeek(mapToPayloadOfWeek);
            const replyMessageSubmit = createReplyMessage(
              logTimesheetByWeekSuccess +
                `${changeDateFormat(daysOfWeek[0])} to ${changeDateFormat(daysOfWeek[6])} `,
              clanIdValue,
              channelId,
              isPublicValue,
              modeValue,
              msg,
            );
            this.messageQueue.addMessage(replyMessageSubmit);
          } else {
            await this.timeSheetService.logTimeSheetByDate(
              typeOfWorkValue,
              taskValue,
              noteValue,
              null,
              workingTimeValue,
              0,
              projectId,
              dateValue,
              ownerSenderEmail,
            );

            const replyMessageSubmit = createReplyMessage(
              logTimesheetByDateSuccess + changeDateFormat(dateValue),
              clanIdValue,
              channelId,
              isPublicValue,
              modeValue,
              msg,
            );
            this.messageQueue.addMessage(replyMessageSubmit);
          }

          break;
        case EUnlockTimeSheet.CANCEL.toLowerCase():
          return;
        default:
          break;
      }
    } catch (error) {
      console.error('Error in handleLogTimesheet:', error.message);
      const replyMessageSubmit = createReplyMessage(
        logTimesheetByDateFail,
        clanIdValue,
        channelId,
        isPublicValue,
        modeValue,
        msg,
      );
      this.messageQueue.addMessage(replyMessageSubmit);
    }
  }
  private temporaryStorage: Record<string, any> = {};
  async handleEventRequestW2(data) {
    if (data.button_id !== 'w2request_CONFIRM') return;
    const baseUrl = process.env.W2_REQUEST_API_BASE_URL;
    const { message_id, extra_data, button_id } = data;
    if (!message_id || !button_id) return;

    const findW2requestData = await this.w2RequestsRepository.findOne({
      where: { messageId: data.message_id },
    });
    const replyMessage: ReplyMezonMessage = {
      clan_id: findW2requestData.clanId,
      channel_id: findW2requestData.channelId,
      is_public: findW2requestData.isChannelPublic,
      mode: findW2requestData.modeMessage,
      msg: {
        t: '',
      },
    };

    if (extra_data === '') {
      replyMessage['msg'] = {
        t: `Missing all data !`,
      };
      this.messageQueue.addMessage(replyMessage);
      return;
    }

    let parsedData;

    try {
      parsedData =
        typeof extra_data === 'string' ? JSON.parse(extra_data) : extra_data;
    } catch (error) {
      replyMessage['msg'] = {
        t: `Invalid JSON format in extra_data`,
      };
      this.messageQueue.addMessage(replyMessage);
      return;
    }

    const storage = this.temporaryStorage[message_id] || {};

    if (!storage.dataInputs) {
      storage.dataInputs = {};
    }

    Object.entries(parsedData?.dataInputs || parsedData).forEach(
      ([key, value]) => {
        if (Array.isArray(value)) {
          storage.dataInputs[key] = value.join(', ');
        } else {
          storage.dataInputs[key] = value;
        }
      },
    );

    this.temporaryStorage[message_id] = storage;

    const existingData = this.temporaryStorage[message_id];

    const additionalData = {
      workflowDefinitionId: findW2requestData.workflowId,
      email: `${findW2requestData.email}@ncc.asia`,
    };

    const completeData = {
      ...additionalData,
      ...existingData,
    };

    let idString = '';
    if (typeof findW2requestData.Id === 'string') {
      idString = findW2requestData.Id;
    } else if (typeof findW2requestData.Id === 'object') {
      idString = JSON.stringify(findW2requestData.Id);
    }
    const arr = idString.replace(/[{}"]/g, '').split(',');
    const missingFields = arr.filter(
      (field) => !completeData?.dataInputs?.[field],
    );

    if (missingFields.length > 0) {
      replyMessage['msg'] = {
        t: `Missing fields : ${missingFields.join(', ')}`,
      };
      this.messageQueue.addMessage(replyMessage);
      return;
    }

    try {
      const agent = new https.Agent({
        rejectUnauthorized: false,
      });
      replyMessage['msg'] = {
        t: `Sending Request....`,
      };
      this.messageQueue.addMessage(replyMessage);
      const response = await axios.post(
        `${baseUrl}/new-instance`,
        completeData,
        {
          headers: {
            'x-secret-key': process.env.W2_REQUEST_X_SECRET_KEY,
          },
          httpsAgent: agent,
        },
      );

      if (response.status === 200) {
        replyMessage['msg'] = {
          t: `Create request successfully!`,
        };
        this.messageQueue.addMessage(replyMessage);
      } else {
        throw new Error('Unexpected response status');
      }
    } catch (error) {
      console.error('Error sending form data:', error);
    }
  }

  async handlePMRequestAbsenceDay(data) {
    const splitButtonId = data.button_id.split('_');
    let typeButtonRes = splitButtonId[1]; // (approve or reject)
    const requestIdButton = splitButtonId[2];
    const requestIds = [Number(requestIdButton)];
    const usernameEmployee = splitButtonId[3];
    const typeRequest = splitButtonId[4];
    const dateAt = splitButtonId[5];
    const dateType = splitButtonId[6];
    try {
      // Find emailAddress by senderId
      const findUser = await this.userRepository
        .createQueryBuilder()
        .where(`"userId" = :userId`, { userId: data.user_id })
        .andWhere(`"deactive" IS NOT true`)
        .select('*')
        .getRawOne();

      if (!findUser) return;
      const authorUsername = findUser.email;
      const emailAddress = generateEmail(authorUsername);
      // Process requests status
      switch (typeButtonRes.trim()) {
        case EPMRequestAbsenceDay.APPROVE:
          try {
            // Call API pm approve request absence day
            const PmAbsenceDayRequestApprove = await this.timeSheetService.PMApproveRequestDay(requestIds, emailAddress);
            if (PmAbsenceDayRequestApprove?.data?.success) {
              const embedSendMessageToPm: EmbedProps[] = [
                {
                  color: '#f2e357',
                  title: `Approve successfully the request: ${usernameEmployee} ${typeRequest} ${dateAt} ${dateType}`,
                },
              ];
              const messageToUser: ReplyMezonMessage = {
                userId: data.user_id,
                textContent: ``,
                messOptions: { embed: embedSendMessageToPm },
              };
              this.messageQueue.addMessage(messageToUser);
              return;
            } else {
              throw new Error('Request failed!');
            }
          } catch (error) {
            const messageError = error.response.data.error.message;
            const embedSendMessageToPm: EmbedProps[] = [
              {
                color: '#FF0000',
                title: `${messageError}`,
              },
            ];
            const messageToUser: ReplyMezonMessage = {
              userId: data.user_id,
              textContent: '',
              messOptions: { embed: embedSendMessageToPm },
            };
            this.messageQueue.addMessage(messageToUser);
          }
          break;
        default:
          try {
            // Call API pm reject request absence day
            const PmAbsenceDayRequestApprove = await this.timeSheetService.PMRejectRequestDay(requestIds, emailAddress);
            if (PmAbsenceDayRequestApprove?.data?.success) {
              const embedSendMessageToPm: EmbedProps[] = [
                {
                  color: '#f2e357',
                  title: `Reject successfully the request: ${usernameEmployee} ${typeRequest} ${dateAt} ${dateType}`,
                },
              ];
              const messageToUser: ReplyMezonMessage = {
                userId: data.user_id,
                textContent: ``,
                messOptions: { embed: embedSendMessageToPm },
              };
              this.messageQueue.addMessage(messageToUser);
            } else {
              throw new Error('Request failed!');
            }
          } catch (error) {
            const messageError = error.response.data.error.message;
            const embedSendMessageToPm: EmbedProps[] = [
              {
                color: '#FF0000',
                title: `${messageError}`,
              },
            ];
            const messageToUser: ReplyMezonMessage = {
              userId: data.user_id,
              textContent: '',
              messOptions: { embed: embedSendMessageToPm },
            };
            this.messageQueue.addMessage(messageToUser);
          }
          break;
      }

    } catch (e) {
      console.error('handleRequestAbsence', e);
    }
  }
}
