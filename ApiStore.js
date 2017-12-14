import {Alert, AsyncStorage} from 'react-native';
import {observable, action, computed} from 'mobx';
import {autobind} from 'core-decorators';
import io from 'socket.io-client';
import feathers from 'feathers/client'
import hooks from 'feathers-hooks';
import socketio from 'feathers-socketio/client'
import authentication from 'feathers-authentication-client';

const API_URL = process.env['CHAT_ENDPOINT'] || "http://hsc-backend.herokuapp.com";

@autobind
export default class ApiStore {

    @observable isAuthenticated = false;
    @observable isConnecting = false;
    @observable user = null;
    @observable chats = [];
    @observable skip = 0;
    @observable alert = {};

    constructor() {
        console.info('API:', API_URL);
        const options = {transports: ['websocket'], pingTimeout: 3000, pingInterval: 5000};
        const socket = io(API_URL, options);

        this.app = feathers()
            .configure(socketio(socket))
            .configure(hooks())
            .configure(authentication({
                storage: AsyncStorage // To store our accessToken
            }));

        this.connect();

        this.app.service('messages').on('created', createdMessage => {
            console.info('Recieved new msg: ', createdMessage);
            this.alert = {
                type: 'info',
                title: createdMessage.sender.prename,
                msg: createdMessage.text
            };
            //Update the msg is delivert
            this.updateMessage(createdMessage, {recieve_date: Date.now()});
        });

        if (this.app.get('accessToken')) {
            this.isAuthenticated = this.app.get('accessToken') !== null;
        }
    }

    connect() {
        this.isConnecting = true;

        this.app.io.on('connect', () => {
            this.isConnecting = false;

            this.authenticate().then(() => {
                console.debug('authenticated after reconnection');
            }).catch(error => {
                console.log('error authenticating after reconnection', error);
            });
        });

        this.app.io.on('disconnect', () => {
            console.info('disconnected');
            this.isConnecting = true;
        });
    }

    createAccount(userData) {
        return this.app.service('users').create(userData).then((result) => {
            return this.authenticate({email: userData.email, password: userData.password, strategy: 'local'})
        });
    }

    updateAccount(user, obj) {
        return this.app.service('users').patch(user.id, obj);
    }


    authenticate(options) {
        options = options ? options : undefined;
        return this._authenticate(options).then(user => {
            console.info('authenticated successfully', user.id, user.email);
            this.user = user;
            this.isAuthenticated = true;
            // Get all current chats
            this.getChats(this.user);
            return Promise.resolve(user);
        }).catch(error => {
            console.log('authenticated failed', error.message);
            return Promise.reject(error);
        });
    }

    _authenticate(payload) {
        return this.app.authenticate(payload)
            .then(response => {
                return this.app.passport.verifyJWT(response.accessToken);
            })
            .then(payload => {
                return this.app.service('users').get(payload.userId);
            }).catch(e => Promise.reject(e));
    }

    promptForLogout() {
        Alert.alert('Abmelden', 'Willst du dich wirklich abmelden?',
            [
                {
                    text: 'Abbrechen', onPress: () => {
                }, style: 'cancel'
                },
                {text: 'Ja', onPress: this.logout, style: 'destructive'},
            ]
        );
    }

    logout() {
        this.app.logout();
        this.skip = 0;
        this.messages = [];
        this.user = null;
        this.isAuthenticated = false;
    }


    findUser(partial) {
        partial = '^' + partial + '[\s\S]*';
        const query = {
            query: {
                $or: [
                    {
                        email: {
                            $search: partial
                        }
                    },
                    {
                        prename: {
                            $search: partial
                        }
                    },
                    {
                        surname: {
                            $search: partial
                        }
                    },
                    {
                        hsid: {
                            $search: partial
                        }
                    }
                ],
                $ne: {
                    id: this.user.id
                }
            }
        };


        return this.app.service('users').find(query).then(response => {
            const users = [];
            for (let user in response.data) {
                users.push(response.data[user]);
            }
            return Promise.resolve(users);
        }).catch(error => {
            console.log('Find User error: ', error);
            return Promise.reject(error);
        });
    }

    /**
     * Returns the a user from the given id
     * @param id of the user you want to find
     * @return {Promise.<user>}
     */
    getUserInformation(id) {
        return this.app.service('users').get(id).then(user => {
            return Promise.resolve(user)
        }).catch(error => {
            console.log('GET', error);
            return Promise.reject(error)
        })
    }

    loadMessages(loadNextPage) {
        let $skip = this.skip;

        const query = {query: {$sort: {createdAt: -1}, $skip}};

        return this.app.service('messages').find(query).then(response => {
            const messages = [];
            const skip = response.skip + response.limit;

            for (let message of response.data) {
                messages.push(this.formatMessage(message));
            }

            console.info('loaded messages from server', JSON.stringify(messages, null, 2));
            if (!loadNextPage) {
                this.messages = messages;
            } else {
                this.messages = this.messages.concat(messages);
            }
            this.skip = skip;
            this.hasMoreMessages = response.skip + response.limit < response.total;

        }).catch(error => {
            console.log('Could not load messages: ', error);
        });
    }

    /**
     * Creats a new chat for for the Person
     * createChat({
     *  owner: this.state.user.id,
     *  recievers: [this.state.res.id]
     * })
     *
     * @param chatData the data for the new Chat
     */
    createChat(chatData) {
        let template = {
            owner: undefined,
            recievers: []
        };

        let data = Object.assign(template, chatData);
        return this.app.service('chats').create(data).then((chat)=>{
            // Check if chat is allready in storage
            if(this.chats.find(o => o.id === chat.id) === undefined){
                this.chats.push(chat);
                console.log('DER CHAT wurde gepushed', chat);
            }
            return chat;
        });
    }

    getChats(user) {
        return this.app.service('chats').find({query: {owner: user.id}}).then((chats)=>{
            console.log('FIND CHATS WTf', this.chats);
            this.chats =chats;
            return chats;
        });
    }


    formatMessage(message) {
        return {
            _id: message.id,
            text: message.text,
            createdAt: message.send_date,
            user: {
                _id: message.sender.id,
                name: message.sender.email,
                avatar: 'https://api.adorable.io/avatars/200/' + message.sender.email,
            }
        };
    }

    /**
     * Creats a new chat for for the Person
     * sendMessage({
     *  text: this.state.text,
     *  sender_id: this.store.user.id,
     *  chat_id: this.state.chat.id
     * })
     *
     * @param message the data for the new Chat
     */
    sendMessage(message) {
        let template = {
            text: undefined,
            sender_id: undefined,
            chat_id: undefined,
            send_date: Date.now(),
            recieve_date: undefined,
            read_date: undefined
        };
        let data = Object.assign(template, message);
        return this.app.service('messages').create(data);
    }

    getMessagesForChat(chat) {
        return this.app.service('messages').find({query: {chat_id: chat.id, $sort: {send_date:-1}}}).then((msgs)=>{
            for(let i in msgs){
                msgs[i]=this.formatMessage(msgs[i]);
            }
            return msgs;
        });
    }

    updateMessage(msg, obj) {
        return this.app.service('messages').patch(msg.id, obj);
    }
}
