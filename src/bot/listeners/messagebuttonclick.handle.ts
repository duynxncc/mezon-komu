import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ChannelMessage, Events } from 'mezon-sdk';
import { BaseHandleEvent } from './base.handle';
import { MezonClientService } from 'src/mezon/services/client.service';
import {
  EmbedProps,
  EMessageMode,
  EUnlockTimeSheet,
  EUnlockTimeSheetPayment,
  MEZON_EMBED_FOOTER,
} from '../constants/configs';
import { MessageQueue } from '../services/messageQueue.service';
import { Daily, Quiz, UnlockTimeSheet, User, UserQuiz } from '../models';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ReplyMezonMessage } from '../asterisk-commands/dto/replyMessage.dto';
import {
  checkAnswerFormat,
  checkButtonAction,
  generateEmail,
  generateQRCode,
  getRandomColor,
  getUserNameByEmail,
} from '../utils/helper';
import { QuizService } from '../services/quiz.services';
import { refGenerate } from '../utils/generateReplyMessage';
import { ChannelDMMezon } from '../models/channelDmMezon.entity';
import { TimeSheetService } from '../services/timesheet.services';
import {
  checkTimeNotWFH,
  checkTimeSheet,
} from '../asterisk-commands/commands/daily/daily.functions';

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
    @InjectRepository(ChannelDMMezon)
    private channelDmMezonRepository: Repository<ChannelDMMezon>,

    private timeSheetService: TimeSheetService,
    @InjectRepository(User)
    private dailyRepository: Repository<Daily>,
  ) {
    super(clientService);
  }

  @OnEvent(Events.MessageButtonClicked)
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

  @OnEvent(Events.MessageButtonClicked)
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
      const value = dataParse?.dataOptions?.[0]?.id.split('_')[1]; // (pm or staff)

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
  @OnEvent(Events.MessageButtonClicked)
  async handleSubmitDaily(data) {
    console.log('data: ', data);

    try {
      // Validate `data.extra_data`
      if (!data.extra_data) {
        throw new Error('extra_data is missing');
      }

      let parsedExtraData;
      try {
        parsedExtraData = JSON.parse(data.extra_data);
      } catch (error) {
        throw new Error('Invalid JSON in extra_data');
      }

      // Validate the structure of `parsedExtraData`
      if (
        !parsedExtraData.dataInputs ||
        typeof parsedExtraData.dataInputs !== 'object'
      ) {
        throw new Error('Invalid structure in parsedExtraData');
      }

      const parsedExtraDataValues =
        Object.values(parsedExtraData.dataInputs) ?? [];
      if (parsedExtraDataValues.length < 3) {
        throw new Error('Missing required data in dataInputs');
      }

      console.log('parsedExtraData: ', parsedExtraData);

      const projectCode = 'Mezon';
      console.log('projectCode: ', projectCode);
      const yesterdayValue = parsedExtraDataValues[0];
      console.log('yesterdayValue: ', yesterdayValue);
      const todayValue = parsedExtraDataValues[1];
      console.log('todayValue: ', todayValue);
      const blockValue = parsedExtraDataValues[2];
      console.log('blockValue: ', blockValue);
      const workingTimeValue = parsedExtraDataValues[3];
      console.log('workingTimeValue: ', workingTimeValue);

      const senderId = data.user_id;
      const channelId = data.channel_id;
      const today = parsedExtraDataValues[2];

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
      console.log(1);
      await this.saveDaily(
        senderId,
        channelId,
        parsedExtraDataValues as string[],
        authorUsername,
      );

      const contentGenerated = `*daily ${projectCode}\n yesterday:${yesterdayValue}\n today:${todayValue}\n block:${blockValue}`;
      console.log('contentGenerated: ', contentGenerated);

      await this.timeSheetService.logTimeSheetFromDaily({
        emailAddress,
        content: contentGenerated,
      });
      console.log(2);
      const isValidTimeFrame = checkTimeSheet();
      const isValidWFH = checkTimeNotWFH();

      const baseMessage = '```✅ Daily saved.```';
      const errorMessageWFH =
        '```✅ Daily saved. (Invalid daily time frame. Please daily at 7h30-9h30, 12h-17h. WFH not daily 20k/time.)```';
      const errorMessageNotWFH =
        '```✅ Daily saved. (Invalid daily time frame. Please daily at 7h30-17h. not daily 20k/time.)```';

      const messageContent = wfhUserEmail.includes(authorUsername)
        ? isValidTimeFrame
          ? baseMessage
          : errorMessageWFH
        : isValidWFH
          ? baseMessage
          : errorMessageNotWFH;

      const buttonType = checkButtonAction(data.button_id);
      console.log('buttonType: ', buttonType);
    } catch (error) {
      console.error('Error in handleSubmitDaily:', error.message);
    }
  }

  saveDaily(
    senderId: string,
    channelId: string,
    args: string[],
    email: string,
  ) {
    console.log({ senderId, channelId, args, email });
    return this.dailyRepository
      .createQueryBuilder()
      .insert()
      .into(Daily)
      .values({
        userid: senderId,
        email: email,
        daily: args.join(' '),
        createdAt: Date.now(),
        channelid: channelId,
      })
      .execute();
  }
}
