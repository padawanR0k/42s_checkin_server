import User from '@entities/user.entity';
import AuthService from '@service/auth.service';
import UserRepository from '@repository/user.repository';
 import CardRepository from '@repository/card.repository';
import config from '@config/configuration';
import axios from 'axios';
import FormData from 'form-data';
import { StatusDTO } from '@dto/status.dto';
import { ClusterDTO } from '@dto/cluster.dto';
import CardService from './card.service';
import { CLUSTER_CODE, CLUSTOM_TYPE } from 'src/enum/cluster';
import { getRepo } from 'src/lib/util';
import { LogService } from './log.service';
import { MyLogger } from './logger.service';
import ConfigService from './config.service';

export default class UserService {
	authService: AuthService;
	private logger: MyLogger;

	private static instance: UserService;

	constructor() {
		this.authService = new AuthService();
		this.logger = new MyLogger();
	}

	static get service() {
		if (!UserService.instance) {
			UserService.instance = new UserService();
		}
		return UserService.instance;
	}

	async login(user: User): Promise<string> {
		try {
			const userRepo = getRepo(UserRepository);
			const existingUser = await userRepo.findOne({
				where: { userId: user.getUserId() }
			});
			//처음 사용하는 유저의 경우 db에 등록
			if (!existingUser) {
				await userRepo.save(user);
				this.logger.debug('new user save : ', user);
			} else {
				existingUser.setEmail(user.getEmail());
				await userRepo.save(existingUser);
			}
			this.logger.debug('Login user : ', existingUser);

			// UseGuards에서 넘어온 user로 JWT token 생성
			return await this.authService.generateToken(existingUser ? existingUser : user);
		} catch (e) {
			this.logger.info(e);
			throw e;
		}
	}

	async checkIsAdmin(adminId: number) {
		this.logger.debug('checkIsAdmin start');
    	this.logger.debug('user _id', adminId);
		const userRepo = getRepo(UserRepository);
		const admin = await userRepo.findOne(adminId);

		if (!admin.getIsAdmin()) throw 'ForbiddenException';
		return true;
	}

	async checkIn(id: number, cardId: string) {
		try {
			this.logger.debug('checkIn start');
      		this.logger.debug('user _id, cardNum', id, cardId);
			const cardRepo = getRepo(CardRepository);
			const userRepo = getRepo(UserRepository);

			//카드 유효성 확인
			const card = await cardRepo.findOne(parseInt(cardId));

			if (!card) throw 'NotFoundException';
			if (card.getStatus()) throw 'BadRequestException';
			//카드 유효성 확인 끝

			//현재 이용자 수 확인
			const usingCard = (await cardRepo.find({
				where: { using: true, type: card.getType() }
			})).length;

			// 최대인원을 넘었으면 다 찼으면 체크인 불가
			const config = await ConfigService.service.getConfig();
			if (usingCard >= config.getMaxCapacity()) throw 'BadRequestException';

			//모두 통과 후 카드 사용 프로세스
			card.useCard();
			await cardRepo.save(card);
			const user = await userRepo.setCard(id, card);
			//카드 사용 프로세스 종료

			// 몇 명 남았는지 디스코드로 노티
			this.noticer(card.getType(), usingCard + 1);

			// 로그 생성
			await LogService.service.createLog(user, card, 'checkIn');

			return true;
		} catch (e) {
			this.logger.info(e);
			return false;
			// throw e;
		}
	}
	async checkOut(id: number) {
		try {
			this.logger.debug('checkOut start');
      		this.logger.debug('user _id', id);
			const cardRepo = getRepo(CardRepository);
			const userRepo = getRepo(UserRepository);

			//반납 프로세스
			const card = await userRepo.getCard(id);
			const type = card.getType();
			await cardRepo.returnCard(card);
			const user = await userRepo.clearCard(id);
			//반납 프로세스 종료

			//사용량 조회
			const usingCard = (await cardRepo.find({
				where: { using: true, type: type }
			})).length;

			//한자리 났다고 노티
			this.noticer(type, usingCard);

			//로그 생성
			await LogService.service.createLog(user, card, 'checkOut');
			return true;
		} catch (e) {
			throw e;
		}
	}

	async noticer(type: number, usingCard: number) {
		const currentConfig = await ConfigService.service.getConfig();
		const maxCapacity = currentConfig.getMaxCapacity();
		if (usingCard >= maxCapacity - 5) {
			const form = new FormData();
			form.append('content', `${maxCapacity - usingCard}명 남았습니다`);
			if (type === 1 || type === 0) {
				const { id, pw } = config.discord[CLUSTER_CODE[type] as CLUSTOM_TYPE];
				axios.post(`https://discord.com/api/webhooks/${id}/${pw}`, {
					form
				}, {
					...form.getHeaders()
				}).then(res => {
					this.logger.info(res);
				}).catch(err => {
					this.logger.error(err);
				});
			}
		}
	}

	async status(id: number) {
		try {
			let returnVal: any = {
				user: null,
				cluster: null,
				isAdmin: false
			};
			this.logger.debug('status start');
      		this.logger.debug('user _id: ', id);
			const userRepo = getRepo(UserRepository);
			const user = await userRepo.findWithCard(id);

			const userInfo = new StatusDTO(user, null);
			const using = await CardService.service.getUsingInfo();
			const cluster = new ClusterDTO(
				using.gaepo,
				using.seocho,
				null,
				null
			);

			returnVal.user = userInfo;
			returnVal.isAdmin = user.getIsAdmin();
			returnVal.cluster = cluster;
			this.logger.debug('status returnVal : ', returnVal);
			return returnVal;
		} catch (e) {

			this.logger.info(e);
			throw e;
		}
	}

	async forceCheckOut(adminId: number, userId: string) {
		try {
			this.logger.debug('forceCheckOut start');
      		this.logger.debug('admin _id, uesr _id', adminId, userId);
			const cardRepo = getRepo(CardRepository);
			const userRepo = getRepo(UserRepository);
			const _userId = parseInt(userId);
			await this.checkIsAdmin(adminId);
			const card = await userRepo.getCard(_userId);
			await cardRepo.returnCard(card);
			const user = await userRepo.clearCard(_userId);
			await LogService.service.createLog(user, card, 'forceCheckOut');
			return user;
		} catch (e) {
			this.logger.info(e);
			throw e;
		}
	}
}
