# vex.dev/web-sdk

TypeScript and JavaScript libraries for developing applications that work with the [Vex Streaming Platform](https://vex.dev).

## Installing
```
npm install @vex.dev/web-sdk
```

## Usage
See the reference documentation and example walk-throughs on the [Vex Documentation Website](https://docs.vex.dev).

## Contributing

### Setup
To prepare your development environment:

```
make setup
```

### Development
When making changes to the web-sdk locally, you can link it to your local version of the [Vex Demo](https://github.com/vex-dev/demo) application, installed as `../demo`, as follows:

Using the local sdk with the Vex Demo app:
```
bin/local-sdk
```

Return to using the published SDK with the Vex Demo app:
```
bin/published-sdk
```

### Deployment

The web-sdk is automatically published to NPM when the version is changed in `package.json`
