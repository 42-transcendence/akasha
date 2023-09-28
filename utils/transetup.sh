#!/bin/bash

# **************************************************************************** #
#                                                                              #
#                                                   :::      ::::::::          #
#    transetup.sh                                 :+:      :+:    :+:          #
#                                               +:+ +:+         +:+            #
#      NodeJS install script                  +#+  +:+       +#+               #
#      for ft_transcendence                 +#+#+#+#+#+   +#+                  #
#                                                #+#    #+#                    #
#    jkong <jkong@student.42seoul.kr>           ###   ########.seoul.kr        #
#                                                                              #
# **************************************************************************** #

SETUP_DIRECTORY=~/goinfre
SHRC_PATH=~/.zshrc

while getopts 'd:s:f' 'name'
do
	case $name in
		d) SETUP_DIRECTORY="$OPTARG" ;;
		s) SHRC_PATH="$OPTARG" ;;
		f) INSTALL_NODE_FORCE=1 ;;

		?)
			printf "Usage: %s: [-d SetUpDirectory] [-s ShellRCPath] [-f]" $0
			exit 2
		;;
	esac
done

if [ ! -d "$SETUP_DIRECTORY" ]
then
	echo "Set-up directory [$SETUP_DIRECTORY] does not exist."
	exit 2
fi

if [ ! -f "$SHRC_PATH" ]
then
	echo "Shell RC file [$SHRC_PATH] does not exist."
	exit 2
fi

function distro_name() {
	case "$(uname -s)" in
		Linux)
			KERNEL_NAME="linux"
			;;
		Darwin)
			KERNEL_NAME="darwin"
			;;
		*)
			echo "Unknown kernel name"
			exit 2
			;;
	esac

	case $(uname -m) in
		x86_64)
			MACHINE_NAME="x64"
			;;
		arm64)
			MACHINE_NAME="arm64"
			;;
		*)
			echo "Unknown machine name"
			exit 2
			;;
	esac

	echo "$KERNEL_NAME-$MACHINE_NAME"
}

function node_version() {
	curl "https://nodejs.org/dist/index.tab" 2> '/dev/null' |
		head -n 2 |
		tail -n 1 |
		while read -r 'ver' '_'
		do
			echo "$ver"
		done
}

NODE_VERSION="$(node_version)"
NODE_DISTRO="$(distro_name)"
NODE_DIST_NAME="node-$NODE_VERSION-$NODE_DISTRO"
ZIP_EXTENSION=".tar.xz"

function validate_node() {
	curl "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" | grep "$NODE_DIST_NAME$ZIP_EXTENSION" | shasum -a 256 -c -
}

function download_node() {
	curl -O "https://nodejs.org/dist/$NODE_VERSION/$NODE_DIST_NAME$ZIP_EXTENSION" && validate_node
}

NODE_DIRECTORY_NAME="node"

function install_node() {
	echo "Install node.js. . ."

	if [ -f "$NODE_DIST_NAME$ZIP_EXTENSION" ]
	then
		echo "File already exists, so we'll validate it first."
		if validate_node
		then
			echo "The integrity of the file has been verified. Continue."
		else
			echo "An existing file is corrupted. Download the file again."
			if ! download_node
			then
				echo "The file failed to download."
				exit 1
			fi
		fi
	else
		echo "Download a new file."
		if ! download_node
		then
			echo "The file failed to download."
			exit 1
		fi
	fi

	mkdir -p "$NODE_DIRECTORY_NAME"
	tar -xvf "$NODE_DIST_NAME$ZIP_EXTENSION" -C "$NODE_DIRECTORY_NAME" --strip-components=1
}

NODE_PATH="$SETUP_DIRECTORY/$NODE_DIRECTORY_NAME/bin"

function export_node_path() {
	if [ $(uname -s) = "Linux" ]
	then
		sed -i '/#Auto-generated-by-42-transcendence-script/d' "$SHRC_PATH"
	else
		sed -i '' '/#Auto-generated-by-42-transcendence-script/d' "$SHRC_PATH"
	fi
	echo 'export PATH='"$NODE_PATH"':$PATH #Auto-generated-by-42-transcendence-script' >> "$SHRC_PATH"

	export PATH="$NODE_PATH:$PATH"
	echo "Exported the PATH environment variable."
}

function move_node_cache() {
	mkdir -p "$SETUP_DIRECTORY/node_cache"
	npm config set cache "$SETUP_DIRECTORY/node_cache" --global

	echo "Changed the path to the NPM cache directory."
}

(
	cd $SETUP_DIRECTORY

	if [ -f .node_installed ]
	then
		if [ -z $INSTALL_NODE_FORCE ]
		then
			echo "You already have a node installed. To force an overwrite and proceed, use the -f option."
			exit 1
		fi
		rm .node_installed
	fi

	install_node
	touch .node_installed
) &&
export_node_path &&
move_node_cache &&
npm install -g \
	npm \
	pnpm \
	@nestjs/cli \
&&
pnpm config set store-dir "$SETUP_DIRECTORY/.pnpm-store"

## NextJS
# pnpm create next-app
# pnpm run dev

## NestJS
# nest new
# pnpm run start:dev

## Prisma
# pnpm install --save-dev prisma
# npx prisma init

## TypeScript
# pnpm install --save-dev typescript ts-node @types/node
# npx tsc --init
# npx ts-node

## ESLint
# npm init @eslint/config
